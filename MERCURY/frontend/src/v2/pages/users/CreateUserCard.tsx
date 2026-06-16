import { useState } from 'react'
import { UserPlus } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Button } from '../../ui/Button'
import { Switch } from '../../ui/Switch'
import * as api from '../../../api/admin'

type Props = {
  onCreated: (apiKey: string) => void
  onError:   (msg: string) => void
}

/**
 * Carte « Ajouter un utilisateur ».
 * Reprend 1:1 le formulaire V1 : identifiant + priorité + threshold.
 * Au succès, propage la clé générée au parent pour affichage modal.
 */
export function CreateUserCard({ onCreated, onError }: Props) {
  const [userId,    setUserId]    = useState('')
  const [priority,  setPriority]  = useState(1)
  const [threshold, setThreshold] = useState(false)
  const [pending,   setPending]   = useState(false)

  const handleCreate = async () => {
    if (!userId.trim()) return
    setPending(true)
    try {
      const res = await api.createUser({
        user_id:   userId.trim(),
        priority,
        threshold,
      })
      onCreated(res.api_key)
      setUserId('')
      setPriority(1)
      setThreshold(false)
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e))
    } finally {
      setPending(false)
    }
  }

  return (
    <Card>
      <CardHeader
        title="Ajouter un utilisateur"
        icon={<UserPlus size={13} />}
      />
      <CardBody className="flex flex-col gap-4">
        <p className="text-[10px] text-muted-foreground/70 m-0">
          Créez un utilisateur et récupérez une clé API. La clé ne sera affichée qu’une seule fois.
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3 items-end">
          {/* Identifiant */}
          <div className="flex flex-col gap-1 xl:col-span-2">
            <label
              htmlFor="users-create-id"
              className="text-[10px] font-medium text-muted-foreground uppercase tracking-widest"
            >
              Identifiant
            </label>
            <input
              id="users-create-id"
              value={userId}
              onChange={e => setUserId(e.target.value)}
              placeholder="Utilisateur"
              className="w-full px-2 py-1.5 bg-background border border-border/60 rounded text-[11px] text-foreground font-mono placeholder:text-muted-foreground/50 focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </div>

          {/* Priorité */}
          <div className="flex flex-col gap-1">
            <label
              htmlFor="users-create-priority"
              className="text-[10px] font-medium text-muted-foreground uppercase tracking-widest"
            >
              Priorité (1 = haute)
            </label>
            <input
              id="users-create-priority"
              type="number"
              min={1}
              value={priority}
              onChange={e => setPriority(Number(e.target.value))}
              className="w-full px-2 py-1.5 bg-background border border-border/60 rounded text-[11px] text-foreground font-mono tabular-nums text-center focus:outline-none focus:ring-2 focus:ring-ring/40"
            />
          </div>

          {/* Threshold */}
          <div className="flex flex-col gap-1 justify-end">
            <span
              className="text-[10px] font-medium text-muted-foreground uppercase tracking-widest"
              title="Activer le grace period pour cet utilisateur : après ses requêtes, le worker attend avant de servir un user moins prioritaire."
            >
              Threshold
            </span>
            <div className="h-[26px] flex items-center">
              <Switch
                checked={threshold}
                onChange={() => setThreshold(!threshold)}
              />
            </div>
          </div>

          {/* Action */}
          <div className="flex flex-col gap-1 justify-end sm:col-span-2 xl:col-span-5">
            <Button
              variant="primary"
              size="md"
              onClick={handleCreate}
              disabled={pending || !userId.trim()}
            >
              <UserPlus size={11} />
              {pending ? '…' : 'Créer et générer une clé'}
            </Button>
          </div>
        </div>
      </CardBody>
    </Card>
  )
}
