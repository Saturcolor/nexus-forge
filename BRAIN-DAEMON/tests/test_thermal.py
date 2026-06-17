"""Tests unitaires pour thermal.controller — la protection VRM (slew-rate) et les constantes
documentées de la courbe thermique.

Ces tests rendent VÉRIFIABLES les claims hardware du README qui, sans matériel AMD Strix Halo,
ne pourraient sinon qu'être « trust me » :
  - le clamp slew-rate (max 500 MHz/tick = 0.5 GHz/s) qui évite les swings brutaux
    5.2 GHz → 625 MHz qui hammerent les VRM partagés CPU/GPU (→ Vulkan "device lost") ;
  - le filtre de bruit (FREQ_WRITE_THRESHOLD) ;
  - le bypass `force=True` pour les transitions d'urgence ;
  - les constantes de la courbe (α EMA = 0.4, seuils d'emergency/resume).

Le constructeur de ThermalController ne touche AUCUN hardware (c'est `start()` qui lit sysfs),
donc on l'instancie tel quel et on mocke uniquement l'écriture sysfs (`root_client.set_cpu_freq`).

Lancer : python -m unittest tests.test_thermal -v   (depuis BRAIN-DAEMON/, Python 3.10+)
"""
import unittest
from unittest.mock import AsyncMock, patch

from thermal import root_client
from thermal.controller import ThermalController


def _make_controller() -> ThermalController:
    # manager n'est pas utilisé par _apply_freq ; un objet factice suffit.
    return ThermalController(manager=object())


class TestSlewRateClamp(unittest.IsolatedAsyncioTestCase):
    async def test_large_downward_jump_is_clamped_to_one_step(self):
        """5.2 GHz → 625 MHz en un tick doit être plafonné à FREQ_MAX_STEP (500 MHz)."""
        c = _make_controller()
        c._last_written_freq = c.CPU_MAX_FREQ  # 5_187_500 kHz
        with patch.object(root_client, "set_cpu_freq", new=AsyncMock(return_value={"ok": True})) as m:
            await c._apply_freq(c.CPU_MIN_FREQ)  # demande 625_000
            expected = c.CPU_MAX_FREQ - c.FREQ_MAX_STEP  # 4_687_500
            m.assert_awaited_once_with(expected)
            self.assertEqual(c._last_written_freq, expected)

    async def test_large_upward_jump_is_clamped_to_one_step(self):
        c = _make_controller()
        c._last_written_freq = c.CPU_MIN_FREQ
        with patch.object(root_client, "set_cpu_freq", new=AsyncMock(return_value={"ok": True})) as m:
            await c._apply_freq(c.CPU_MAX_FREQ)
            expected = c.CPU_MIN_FREQ + c.FREQ_MAX_STEP  # 1_125_000
            m.assert_awaited_once_with(expected)

    async def test_descent_takes_multiple_ticks(self):
        """Le clamp impose une descente par paliers : deux ticks = deux pas de 500 MHz max."""
        c = _make_controller()
        c._last_written_freq = c.CPU_MAX_FREQ
        with patch.object(root_client, "set_cpu_freq", new=AsyncMock(return_value={"ok": True})):
            await c._apply_freq(c.CPU_MIN_FREQ)
            self.assertEqual(c._last_written_freq, c.CPU_MAX_FREQ - c.FREQ_MAX_STEP)
            await c._apply_freq(c.CPU_MIN_FREQ)
            self.assertEqual(c._last_written_freq, c.CPU_MAX_FREQ - 2 * c.FREQ_MAX_STEP)

    async def test_small_delta_below_threshold_is_ignored(self):
        """Une variation < FREQ_WRITE_THRESHOLD est du bruit thermique : aucune écriture sysfs."""
        c = _make_controller()
        c._last_written_freq = 5_000_000
        with patch.object(root_client, "set_cpu_freq", new=AsyncMock()) as m:
            await c._apply_freq(5_000_000 + (c.FREQ_WRITE_THRESHOLD - 1))
            m.assert_not_awaited()
            self.assertEqual(c._last_written_freq, 5_000_000)

    async def test_delta_within_step_writes_target_directly(self):
        """Entre le seuil de bruit et FREQ_MAX_STEP : pas de clamp, on écrit la cible telle quelle."""
        c = _make_controller()
        c._last_written_freq = 4_000_000
        target = 4_000_000 + 400_000  # > threshold (300k), <= step (500k)
        with patch.object(root_client, "set_cpu_freq", new=AsyncMock(return_value={"ok": True})) as m:
            await c._apply_freq(target)
            m.assert_awaited_once_with(target)

    async def test_force_bypasses_slew_rate(self):
        """force=True (emergency/shutdown) atteint la cible immédiatement, sans rate-limit."""
        c = _make_controller()
        c._last_written_freq = c.CPU_MAX_FREQ
        with patch.object(root_client, "set_cpu_freq", new=AsyncMock(return_value={"ok": True})) as m:
            await c._apply_freq(c.CPU_MIN_FREQ, force=True)
            m.assert_awaited_once_with(c.CPU_MIN_FREQ)
            self.assertEqual(c._last_written_freq, c.CPU_MIN_FREQ)

    async def test_first_write_has_no_reference_and_writes_directly(self):
        """Premier write (last==0) : pas de référence pour le rate-limit → écriture directe."""
        c = _make_controller()
        self.assertEqual(c._last_written_freq, 0)
        with patch.object(root_client, "set_cpu_freq", new=AsyncMock(return_value={"ok": True})) as m:
            await c._apply_freq(3_000_000)
            m.assert_awaited_once_with(3_000_000)
            self.assertEqual(c._last_written_freq, 3_000_000)


class TestDocumentedConstants(unittest.TestCase):
    """Épingle au code les valeurs annoncées dans le README (les rendre falsifiables)."""

    def test_constants_match_readme_claims(self):
        self.assertEqual(ThermalController.TEMP_EMA_ALPHA, 0.4)
        self.assertEqual(ThermalController.FREQ_MAX_STEP, 500_000)  # 500 MHz / tick
        self.assertEqual(ThermalController.T_EMERGENCY, 98)         # SIGSTOP
        self.assertEqual(ThermalController.T_RESUME, 55)            # SIGCONT
        self.assertEqual(ThermalController.T_THROTTLE_START, 75)
        self.assertEqual(ThermalController.T_THROTTLE_FULL, 90)

    def test_slew_rate_is_half_ghz_per_second(self):
        """README : 'plafonne le slew rate à 0.5 GHz/s' = FREQ_MAX_STEP / INTERVAL."""
        rate_khz_per_s = ThermalController.FREQ_MAX_STEP / ThermalController.INTERVAL
        self.assertEqual(rate_khz_per_s, 500_000)  # 0.5 GHz/s


if __name__ == "__main__":
    unittest.main()
