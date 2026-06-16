import { useQueue, useConfig, useSaveConfigMutation } from '../../../api/queries'
import type { Config } from '../../../api/admin'
import { Cloud } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { StatTile } from '../../ui/StatTile'
import { Switch } from '../../ui/Switch'

export function CloudStatsCard() {
  const { data: queue }            = useQueue()
  const { data: config }           = useConfig()
  const saveConfigMutation         = useSaveConfigMutation()

  const cloudBypass    = config?.cloud_bypass_queue !== false
  const inProgress     = queue?.cloud_in_progress      ?? 0
  const processed      = queue?.cloud_processed        ?? 0
  const inProgressList = queue?.cloud_in_progress_list ?? []

  const handleToggleBypass = async () => {
    if (!config) return
    try {
      await saveConfigMutation.mutateAsync({ ...config, cloud_bypass_queue: !cloudBypass } as Config)
    } catch { /* ignore */ }
  }

  return (
    <Card>
      <CardHeader
        title="Requêtes Cloud"
        icon={<Cloud size={13} />}
        right={
          <Switch label="Bypass queue" checked={cloudBypass} onChange={handleToggleBypass} />
        }
      />
      <CardBody className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <StatTile
            label="En cours"
            value={inProgress}
            tone={inProgress > 0 ? 'primary' : 'muted'}
          />
          <StatTile
            label="Traitées"
            value={processed}
            tone={processed > 0 ? 'success' : 'default'}
          />
        </div>

        {inProgressList.length > 0 && (
          <div className="overflow-auto max-h-40 rounded-lg border border-border/40 bg-background">
            <table className="w-full text-left border-collapse">
              <thead className="sticky top-0 bg-background/95 backdrop-blur-sm">
                <tr>
                  <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider border-b border-border/40">Modèle</th>
                  <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider border-b border-border/40">User</th>
                  <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider border-b border-border/40">Backend</th>
                </tr>
              </thead>
              <tbody>
                {inProgressList.map((item, i) => (
                  <tr key={i} className="border-b border-border/30 last:border-b-0 hover:bg-secondary/20">
                    <td className="px-3 py-2 font-mono text-[11px] text-foreground">{item.model}</td>
                    <td className="px-3 py-2 text-[11px] text-muted-foreground">{item.user_id}</td>
                    <td className="px-3 py-2">
                      <Badge tone="primary" mono>{item.backend}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {!cloudBypass && (
          <p className="text-[11px] text-theme-amber">
            Bypass désactivé — les requêtes cloud passent par la file séquentielle.
          </p>
        )}
      </CardBody>
    </Card>
  )
}
