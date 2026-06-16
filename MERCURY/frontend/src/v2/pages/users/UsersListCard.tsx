import { Users, Trash2 } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import * as api from '../../../api/admin'
import type { UserEntry } from '../../../api/admin'

type Props = {
  users:   UserEntry[]
  reload:  () => void
  onError: (msg: string) => void
}

/**
 * Carte « Utilisateurs existants ».
 * Affiche la liste, le toggle threshold et la suppression — équivalent 1:1 au tableau V1.
 */
export function UsersListCard({ users, reload, onError }: Props) {
  const handleToggleThreshold = async (user_id: string, current: boolean) => {
    try {
      await api.updateUser({ user_id, threshold: !current })
      reload()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  const handleDelete = async (user_id: string) => {
    if (!confirm(`Supprimer l'utilisateur « ${user_id} » ?`)) return
    try {
      await api.deleteUser(user_id)
      reload()
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Card>
      <CardHeader
        title="Utilisateurs existants"
        icon={<Users size={13} />}
        right={
          <Badge tone="muted" mono>{users.length}</Badge>
        }
      />
      <CardBody className="flex flex-col gap-3">
        <p className="text-[10px] text-muted-foreground/70 m-0">
          Liste des utilisateurs et préfixes de clé. Supprimez un utilisateur pour invalider sa clé.
        </p>

        {users.length === 0 ? (
          <p className="text-[11px] text-muted-foreground m-0">
            Aucun utilisateur. Créez-en un ci-dessus.
          </p>
        ) : (
          <div className="overflow-auto rounded-lg border border-border/40 bg-background">
            <table className="w-full min-w-[520px] text-left border-collapse">
              <thead className="sticky top-0 bg-background/95 backdrop-blur-sm">
                <tr>
                  <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider border-b border-border/40">Identifiant</th>
                  <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider border-b border-border/40">Priorité</th>
                  <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider border-b border-border/40 text-center">Threshold</th>
                  <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider border-b border-border/40">Clé (masquée)</th>
                  <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground/70 uppercase tracking-wider border-b border-border/40 w-20"></th>
                </tr>
              </thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.user_id} className="border-b border-border/30 last:border-b-0 hover:bg-secondary/20">
                    <td className="px-3 py-2 text-[11px] text-foreground font-medium">{u.user_id}</td>
                    <td className="px-3 py-2 text-[11px] text-foreground font-mono tabular-nums">{u.priority}</td>
                    <td className="px-3 py-2 text-center">
                      <button
                        type="button"
                        onClick={() => handleToggleThreshold(u.user_id, u.threshold)}
                        title={u.threshold
                          ? 'Threshold actif — cliquer pour désactiver'
                          : 'Threshold inactif — cliquer pour activer'}
                        className={
                          u.threshold
                            ? 'inline-flex items-center justify-center w-6 h-6 rounded border border-theme-amber/40 bg-theme-amber/10 text-theme-amber hover:bg-theme-amber/20 transition-colors'
                            : 'inline-flex items-center justify-center w-6 h-6 rounded border border-border/60 bg-background text-muted-foreground/60 hover:border-muted-foreground hover:text-muted-foreground transition-colors'
                        }
                      >
                        <span className="text-[10px] leading-none">{u.threshold ? '●' : '○'}</span>
                      </button>
                    </td>
                    <td className="px-3 py-2 text-[11px] text-muted-foreground font-mono">{u.key_prefix}</td>
                    <td className="px-3 py-2">
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleDelete(u.user_id)}
                        title="Supprimer"
                      >
                        <Trash2 size={11} />
                        Supprimer
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
