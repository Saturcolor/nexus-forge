import { useState, useEffect } from 'react'
import { Compass } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge, StatusDot } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Switch } from '../../ui/Switch'
import { useConfig, useSaveConfigMutation, useAtlasHealth } from '../../../api/queries'
import type { Config } from '../../../api/admin'

/**
 * AtlasCard V2 — section "atlas" dans l'onglet Brain.
 *
 * Atlas = extraction de control vectors via brain-daemon /atlas/*
 * (orchestré ensuite par l'app atlasmind sur le VPS).
 *
 * Cette card configure le passthrough Mercury et observe le backend brain,
 * elle ne lance pas d'extractions elle-même (c'est atlasmind qui s'en charge).
 *
 * Endpoints :
 * - GET /atlas/health (route publique Mercury, ping toutes 5s)
 * - POST /admin/config (toggle atlas_enabled + brain_url + timeout)
 */
export function AtlasCard() {
  const { data: config } = useConfig()
  const saveMut = useSaveConfigMutation()

  // Local form state (dirty pattern)
  const [atlasEnabled, setAtlasEnabled] = useState<boolean>(false)
  const [brainUrl, setBrainUrl] = useState<string>('')
  const [atlasmindUrl, setAtlasmindUrl] = useState<string>('')
  const [atlasmindApiKey, setAtlasmindApiKey] = useState<string>('')
  const [timeoutSec, setTimeoutSec] = useState<number>(1800)
  const [loaded, setLoaded] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (config && !loaded) {
      setAtlasEnabled(config.atlas_enabled === true)
      setBrainUrl(config.atlas_brain_url ?? 'http://127.0.0.1:4321')
      setAtlasmindUrl(config.atlas_atlasmind_url ?? 'http://127.0.0.1:9300')
      setAtlasmindApiKey(config.atlas_atlasmind_api_key ?? '')
      setTimeoutSec(config.atlas_timeout_sec ?? 1800)
      setLoaded(true)
    }
  }, [config, loaded])

  const markDirty = () => {
    setDirty(true)
    setSaved(false)
  }

  // Health polling (shared React Query hook, refetchInterval 5s — cf. useAtlasHealth)
  const { data: health, error: healthError, isFetching: healthLoading, refetch: refetchHealth } = useAtlasHealth()
  const healthErr = healthError ? (healthError instanceof Error ? healthError.message : String(healthError)) : null
  const fetchHealth = () => { refetchHealth() }

  const handleSave = () => {
    if (!config) return
    const merged: Config = {
      ...config,
      atlas_enabled: atlasEnabled,
      atlas_brain_url: brainUrl.trim() || undefined,
      atlas_atlasmind_url: atlasmindUrl.trim() || undefined,
      atlas_atlasmind_api_key: atlasmindApiKey.trim() || undefined,
      atlas_timeout_sec: timeoutSec,
    }
    saveMut.mutate(merged, {
      onSuccess: () => {
        setDirty(false)
        setSaved(true)
        setTimeout(() => setSaved(false), 2000)
        setTimeout(fetchHealth, 500)
      },
    })
  }

  // Status visuel
  const brainUp = !healthErr && !health?.upstream_error
  let statusTone: 'neutral' | 'warning' | 'destructive' | 'success' | 'primary' = 'neutral'
  let statusLabel = 'Inconnu'

  if (!atlasEnabled) {
    statusTone = 'neutral'
    statusLabel = 'Désactivé'
  } else if (!brainUp) {
    statusTone = 'destructive'
    statusLabel = 'Brain inaccessible'
  } else if (!health?.enabled) {
    statusTone = 'warning'
    statusLabel = 'Brain désactivé'
  } else if (!health?.initialized) {
    statusTone = 'warning'
    statusLabel = 'Init…'
  } else if (health?.current_job) {
    statusTone = 'primary'
    statusLabel = `Extraction (${health.current_job.job_id ?? '?'})`
  } else {
    statusTone = 'success'
    statusLabel = 'OK'
  }

  return (
    <Card>
      <CardHeader
        title="Atlas"
        subtitle="Extraction de control vectors (activation steering)"
        icon={<Compass size={13} />}
        right={
          <>
            <StatusDot tone={statusTone} pulse={healthLoading || statusTone === 'primary'} />
            <Badge tone={statusTone}>{statusLabel}</Badge>
            <Button size="sm" variant="ghost" onClick={fetchHealth}>
              Rafraîchir
            </Button>
          </>
        }
      />
      <CardBody>
        {/* Toggle Mercury passthrough */}
        <div className="flex items-center justify-between gap-3 pb-3 mb-3 border-b border-border/40">
          <div className="flex flex-col gap-0.5 min-w-0">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Passthrough Mercury
            </span>
            <span className="text-[11px] text-foreground">
              Active la route <code className="text-[10px] text-primary">/atlas/*</code>{' '}
              sur Mercury (proxy vers brain-daemon).
            </span>
          </div>
          <Switch
            checked={atlasEnabled}
            onChange={() => {
              setAtlasEnabled((v) => !v)
              markDirty()
            }}
          />
        </div>

        {/* Brain URL + AtlasMind URL + timeout (visible seulement si activé) */}
        {atlasEnabled && (
          <div className="grid grid-cols-3 gap-3 mb-3">
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                Brain URL
              </span>
              <input
                type="text"
                value={brainUrl}
                onChange={(e) => {
                  setBrainUrl(e.target.value)
                  markDirty()
                }}
                placeholder="http://127.0.0.1:4321"
                className="px-2 py-1 bg-background border border-border rounded text-[11px] text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
            </div>
            <div className="flex flex-col gap-1">
              <span
                className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider"
                title="App AtlasMind (presets cocktail control_vector). Mercury y proxy /atlas/presets et /atlas/mgmt/apply-preset."
              >
                AtlasMind URL
              </span>
              <input
                type="text"
                value={atlasmindUrl}
                onChange={(e) => {
                  setAtlasmindUrl(e.target.value)
                  markDirty()
                }}
                placeholder="http://127.0.0.1:9300"
                className="px-2 py-1 bg-background border border-border rounded text-[11px] text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
            </div>
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                Timeout (sec)
              </span>
              <input
                type="number"
                min={60}
                max={7200}
                value={timeoutSec}
                onChange={(e) => {
                  setTimeoutSec(Number(e.target.value))
                  markDirty()
                }}
                className="px-2 py-1 bg-background border border-border rounded text-[11px] text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-ring/40"
              />
            </div>
          </div>
        )}

        {/* AtlasMind API key (optionnel — seulement si AtlasMind a son auth.api_key activée) */}
        {atlasEnabled && (
          <div className="flex flex-col gap-1 mb-3">
            <span
              className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider"
              title="Optionnel — à remplir UNIQUEMENT si AtlasMind a son auth.api_key activée côté config. Laissé vide = pas de Bearer envoyé (AtlasMind ouvert par défaut)."
            >
              AtlasMind API key (optionnel)
            </span>
            <input
              type="password"
              value={atlasmindApiKey}
              onChange={(e) => {
                setAtlasmindApiKey(e.target.value)
                markDirty()
              }}
              placeholder="vide = pas d'auth (default AtlasMind)"
              autoComplete="off"
              className="px-2 py-1 bg-background border border-border rounded text-[11px] text-foreground font-mono focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </div>
        )}

        {/* Save bar */}
        <div className="flex items-center justify-end gap-3 pt-2 mb-3 border-t border-border/40">
          {dirty && (
            <span className="text-[10px] text-theme-amber">
              Modifications non sauvegardées
            </span>
          )}
          {saved && <span className="text-[10px] text-theme-green">✓ Enregistré</span>}
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={!loaded || saveMut.isPending || !dirty}
          >
            {saveMut.isPending ? '…' : 'Enregistrer'}
          </Button>
        </div>

        {/* Backend status detail */}
        {atlasEnabled && (
          <div className="flex flex-col gap-2 pt-3 border-t border-border/40">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
              Backend brain-daemon
            </span>

            {healthErr && (
              <div className="text-[11px] text-destructive">
                ⚠ Mercury → brain : {healthErr}
              </div>
            )}

            {!healthErr && health?.upstream_error && (
              <div className="text-[11px] text-destructive">
                ⚠ Brain inaccessible : {health.upstream_error}
                {health.configured_brain_url && (
                  <div className="text-[10px] text-muted-foreground/70 mt-0.5">
                    URL configurée : <code>{health.configured_brain_url}</code>
                  </div>
                )}
              </div>
            )}

            {!healthErr && !health?.upstream_error && health && (
              <div className="grid grid-cols-3 gap-3">
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] text-muted-foreground">Module</span>
                  <span className="text-[11px]">
                    {health.enabled ? (
                      <span className="text-theme-green">✓ activé</span>
                    ) : (
                      <span className="text-theme-amber">✗ désactivé</span>
                    )}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] text-muted-foreground">Initialisé</span>
                  <span className="text-[11px]">
                    {health.initialized ? (
                      <span className="text-theme-green">✓ oui</span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </span>
                </div>
                <div className="flex flex-col gap-0.5">
                  <span className="text-[10px] text-muted-foreground">Job</span>
                  <span className="text-[11px]">
                    {health.current_job ? (
                      <span
                        className="text-primary"
                        title={JSON.stringify(health.current_job)}
                      >
                        ⏵ {health.current_job.job_id}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">idle</span>
                    )}
                  </span>
                </div>
              </div>
            )}

            {/* Hint d'install si activé Mercury mais désactivé brain */}
            {!healthErr &&
              !health?.upstream_error &&
              health &&
              health.enabled === false && (
                <div className="mt-1 bg-background border border-border/60 rounded p-2 text-[10px] text-muted-foreground font-mono overflow-auto">
                  <div className="text-muted-foreground/60 mb-1">
                    # Activer côté brain-daemon (/opt/llamacpp-daemon/config.yaml)
                  </div>
                  <pre className="m-0 whitespace-pre-wrap text-foreground">{`atlas:
  enabled: true
  output_dir: /var/lib/atlas/vectors
  extractor_binary: /opt/llamacpp-atlas/build/bin/llama-extract-vector
  default_ngl: 99
  default_threads: 8
  cleanup_temp_files: true
  serialize_extractions: true`}</pre>
                  <div className="text-muted-foreground/60 mt-2">
                    # Puis : sudo systemctl restart brain-daemon
                  </div>
                </div>
              )}
          </div>
        )}

        {!atlasEnabled && (
          <div className="text-[11px] text-muted-foreground/70 pt-3 border-t border-border/40">
            Atlas n'est utile que pour l'activation steering. Active le passthrough
            ci-dessus puis configure le backend côté brain-daemon. Voir{' '}
            <code className="text-muted-foreground">BRAIN-DAEMON/atlas/README.md</code>.
          </div>
        )}
      </CardBody>
    </Card>
  )
}
