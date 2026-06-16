/**
 * Composant réutilisable pour configurer une URL de probe (host + port).
 * Élimine la duplication entre Ollama et LM Studio dans ConfigPanel.
 */

const inputClass = 'w-full px-3 py-2 bg-neutral-950 border border-neutral-700 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm text-white placeholder:text-neutral-500'
const labelClass = 'text-sm font-medium text-neutral-300'
const fieldClass = 'flex flex-col gap-1.5'

type Props = {
  id: string
  value: string
  onChange: (url: string) => void
  label?: string
  description?: string
  defaultPort?: string
}

function extractPort(url: string, defaultPort: string): string {
  if (!url.trim()) return ''
  try {
    const parsed = new URL(url.startsWith('http') ? url : `http://${url}`)
    return parsed.port || defaultPort
  } catch {
    return defaultPort
  }
}

function updatePort(base: string, port: string, defaultPort: string): string {
  const cleanPort = port.replace(/\D/g, '').slice(0, 5)
  try {
    if (!base.trim()) {
      return cleanPort ? `http://localhost:${cleanPort}` : ''
    }
    const url = new URL(base.startsWith('http') ? base : `http://${base}`)
    url.port = cleanPort || defaultPort
    return url.origin
  } catch {
    return cleanPort ? `http://localhost:${cleanPort}` : ''
  }
}

export default function ProbeUrlField({ id, value, onChange, label, description, defaultPort = '9090' }: Props) {
  return (
    <div className="border-t border-neutral-700/60 pt-3 mt-1">
      <span className="text-xs font-semibold text-neutral-500 uppercase tracking-wider">{label ?? 'Probe (stats machine hôte)'}</span>
      {description && <p className="text-xs text-neutral-500 mt-0.5 mb-2">{description}</p>}
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-3">
        <div className={fieldClass}>
          <label htmlFor={`${id}-url`} className={labelClass}>Lien (host ou URL)</label>
          <input
            id={`${id}-url`}
            value={value}
            onChange={e => onChange(e.target.value)}
            placeholder="http://192.168.1.10 ou vide"
            className={inputClass}
            title="URL complète (ex. http://192.168.1.10:9090) ou host seul"
          />
        </div>
        <div className={`${fieldClass} sm:w-24`}>
          <label htmlFor={`${id}-port`} className={labelClass}>Port</label>
          <input
            id={`${id}-port`}
            type="number"
            min={1}
            max={65535}
            value={extractPort(value, defaultPort)}
            onChange={e => onChange(updatePort(value, e.target.value, defaultPort))}
            placeholder={defaultPort}
            className={inputClass}
            title={`Port de la probe (défaut ${defaultPort})`}
          />
        </div>
      </div>
    </div>
  )
}
