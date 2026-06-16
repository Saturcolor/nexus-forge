"""OmniVoice (k2-fsa) wrapper — diffusion TTS zero-shot voice clone, 646 langues.

Le modèle est cloné via scripts/install_omnivoice.sh dans /opt/omnivoice-src puis
installé en éditable. On l'importe lazy pour ne pas payer le coût torch.compile
quand omnivoice.enabled = false.

Output : tensor (1, n_samples) @ 24kHz mono.
Latence cible : <2s par phrase courte sur GPU correct (16 num_step de diffusion).
"""
from __future__ import annotations

import io
import logging
import time
from pathlib import Path
from typing import Optional

logger = logging.getLogger("brain-daemon")


class OmniVoiceEngine:
    """Wrap le modèle k2-fsa/OmniVoice avec API simple synthesize() + clone().

    Charge le modèle au premier appel (lazy) sauf si preload=True dans init_models.
    Le modèle pèse ~2-4GB GPU, on évite donc de le charger si non utilisé.
    """

    SAMPLE_RATE = 24000  # canonical OmniVoice rate

    def __init__(self):
        self._model = None
        self._device: str = "cpu"
        self._loaded = False
        self._load_error: Optional[str] = None
        # Defaults — surchargés par configure() au boot si omnivoice.enabled=true.
        # Initialisés ici pour que load() à chaud (depuis Mercury, sans config.yaml)
        # ne crash pas sur AttributeError.
        self._num_step = 16
        self._guidance_scale = 2.0
        self._device_pref: str = "auto"
        self._model_path: str = ""

    @property
    def loaded(self) -> bool:
        return self._loaded

    @property
    def device(self) -> str:
        return self._device

    def configure(self, cfg: dict) -> None:
        """Read omnivoice section from daemon config."""
        self._num_step = int(cfg.get("num_step", 16))
        self._guidance_scale = float(cfg.get("guidance_scale", 2.0))
        self._device_pref = cfg.get("device", "auto")
        self._model_path = cfg.get("model_path", "")

    def load(self) -> bool:
        """Force-load the model. Returns True on success."""
        if self._loaded:
            return True
        try:
            import torch
            from omnivoice.models.omnivoice import OmniVoice
        except Exception as e:
            self._load_error = f"import failed: {e}"
            logger.error("OmniVoice import failed: %s", e)
            return False

        device = self._resolve_device(torch)
        logger.info("OmniVoice loading on device=%s (model_path=%s)", device, self._model_path or "default")
        t0 = time.monotonic()
        try:
            if self._model_path:
                self._model = OmniVoice.from_pretrained(self._model_path)
            else:
                self._model = OmniVoice.from_pretrained("k2-fsa/OmniVoice")
            self._model = self._model.to(device).eval()
            if device == "cuda":
                self._model = self._model.half()
        except Exception as e:
            self._load_error = f"load failed: {e}"
            logger.exception("OmniVoice load failed: %s", e)
            return False

        self._device = device
        self._loaded = True
        logger.info("OmniVoice loaded in %.1fs (device=%s, dtype=%s)",
                    time.monotonic() - t0, device, "fp16" if device == "cuda" else "fp32")
        return True

    def _resolve_device(self, torch) -> str:
        pref = self._device_pref or "auto"
        if pref != "auto":
            return pref
        if torch.cuda.is_available():
            return "cuda"  # NVIDIA or ROCm-as-cuda
        if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            return "mps"
        return "cpu"

    def synthesize(
        self,
        text: str,
        *,
        ref_audio: Optional[str] = None,
        ref_text: Optional[str] = None,
        instruct: Optional[str] = None,
        description: Optional[str] = None,
        language: Optional[str] = None,
        speed: float = 1.0,
        num_step: Optional[int] = None,
        guidance_scale: Optional[float] = None,
    ) -> tuple[bytes, int]:
        """Synthesize text → WAV bytes.

        Three modes:
          * Voice clone : pass ref_audio (5-15s WAV) + ref_text (transcript).
          * Voice design : pass description ("young female, warm, British") + instruct.
          * Auto voice : neither — random voice from the model prior.

        Returns (wav_bytes, sample_rate).
        """
        if not self._loaded:
            raise RuntimeError(f"OmniVoice not loaded ({self._load_error or 'call load() first'})")

        import torch
        kw: dict = {
            "num_step": num_step or self._num_step,
            "guidance_scale": guidance_scale or self._guidance_scale,
            "speed": speed,
        }
        if ref_audio:
            kw["ref_audio"] = ref_audio
        if ref_text:
            kw["ref_text"] = ref_text
        if instruct:
            kw["instruct"] = instruct
        if description:
            kw["description"] = description
        if language and language.lower() not in ("auto", ""):
            kw["language"] = language

        t0 = time.monotonic()
        try:
            with torch.inference_mode():
                audios = self._model.generate(text=text, **kw)
        except Exception as e:
            # k2-fsa OmniVoice peut rejeter la combinaison `ref_audio + instruct`
            # (voice clone et voice-design sont en théorie deux modes distincts).
            # Plutôt que de remonter un 500 opaque, on retente sans instruct :
            # le clone est préservé, on perd uniquement le hint de prosodie.
            if "instruct" in kw and "ref_audio" in kw:
                logger.warning(
                    "OmniVoice generate failed with instruct+ref_audio (%s) — "
                    "retry without instruct so the clone still works",
                    e,
                )
                kw_no_instruct = {k: v for k, v in kw.items() if k != "instruct"}
                with torch.inference_mode():
                    audios = self._model.generate(text=text, **kw_no_instruct)
            else:
                logger.exception("OmniVoice generate failed (kw keys=%s): %s", list(kw.keys()), e)
                raise
        dt = time.monotonic() - t0

        # OmniVoice.generate returns list[Tensor] of shape (1, n) at 24kHz
        audio = audios[0] if isinstance(audios, (list, tuple)) else audios
        if audio.ndim == 2:
            audio = audio[0]
        wav_bytes = self._tensor_to_wav(audio)
        logger.info("OmniVoice synth: %d chars → %.1fs audio in %.2fs (ref=%s)",
                    len(text), len(wav_bytes) / (self.SAMPLE_RATE * 2),
                    dt, bool(ref_audio))
        return wav_bytes, self.SAMPLE_RATE

    def _tensor_to_wav(self, audio) -> bytes:
        import numpy as np
        import soundfile as sf
        import torch
        if isinstance(audio, torch.Tensor):
            arr = audio.detach().cpu().to(torch.float32).numpy()
        else:
            arr = np.asarray(audio, dtype=np.float32)
        if arr.ndim > 1:
            arr = arr.squeeze()
        logger.info("OmniVoice _tensor_to_wav: dtype=%s shape=%s", arr.dtype, arr.shape)
        buf = io.BytesIO()
        sf.write(buf, arr, self.SAMPLE_RATE, format="WAV", subtype="PCM_16")
        buf.seek(0)
        return buf.read()

    def unload(self) -> bool:
        """Free the model and reset state (does not persist anything to disk)."""
        if not self._loaded:
            return False
        try:
            import torch
            self._model = None
            if self._device == "cuda":
                torch.cuda.empty_cache()
        except Exception as e:
            logger.warning("OmniVoice unload: cleanup partial: %s", e)
        self._loaded = False
        self._device = "cpu"
        self._load_error = None
        logger.info("OmniVoice unloaded")
        return True

    def status(self) -> dict:
        return {
            "loaded": self._loaded,
            "device": self._device,
            "sample_rate": self.SAMPLE_RATE,
            "num_step": self._num_step,
            "guidance_scale": self._guidance_scale,
            "error": self._load_error,
        }
