import { Shield } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { ConfigCheckbox } from './ConfigCheckbox'
import { inputCls, labelCls, fieldCls, groupCls, type SectionProps } from './shared'

type SecurityCardProps = SectionProps & {
  adminTokenSet: boolean
  requireAuth: boolean
  setRequireAuth: (v: boolean) => void
  adminTokenInput: string
  setAdminTokenInput: (v: string) => void
}

export function SecurityCard({ config, updateField, markDirty, adminTokenSet, requireAuth, setRequireAuth, adminTokenInput, setAdminTokenInput }: SecurityCardProps) {
  return (
    <Card>
      <CardHeader title="Sécurité & Accès" icon={<Shield size={13} />} />
      <CardBody className="!py-4 flex flex-col gap-5">
        <div className="flex flex-col gap-3">
          <span className={groupCls}>Authentification admin</span>
          <ConfigCheckbox
            id="cfg-require-auth"
            checked={requireAuth}
            onChange={e => { markDirty(); setRequireAuth(e.target.checked) }}
            label="Token admin requis"
            hint="Exiger un token pour accéder aux routes /admin."
          />
          {requireAuth && (
            <div className={fieldCls}>
              <label htmlFor="cfg-admin-token" className={labelCls}>Token admin</label>
              <input
                id="cfg-admin-token"
                type="password"
                value={adminTokenInput}
                onChange={e => { markDirty(); setAdminTokenInput(e.target.value) }}
                placeholder={adminTokenSet ? '•••••••• (vide = ne pas changer)' : 'Saisir le token'}
                autoComplete="off"
                className={inputCls}
              />
            </div>
          )}
        </div>

        <div className="flex flex-col gap-3">
          <span className={groupCls}>Contrôle d'accès API</span>
          <ConfigCheckbox
            id="cfg-admin-accept-user-key"
            checked={config.admin_accept_user_api_key !== false}
            onChange={e => updateField('admin_accept_user_api_key', e.target.checked)}
            label="Accepter les clés users sur /admin"
            hint="Permet d'utiliser un token utilisateur pour les routes /admin/*."
          />
          <ConfigCheckbox
            id="cfg-require-api-key"
            checked={config.require_api_key === true}
            onChange={e => updateField('require_api_key', e.target.checked)}
            label="Clé API requise"
            hint="Exiger une clé API pour /v1/chat/completions."
          />
          <div className={fieldCls}>
            <label htmlFor="cfg-anonymous-priority" className={labelCls}>Priorité anonyme</label>
            <input
              id="cfg-anonymous-priority"
              type="number"
              value={config.anonymous_priority ?? 99}
              min={1}
              max={999}
              onChange={e => updateField('anonymous_priority', Number(e.target.value))}
              className={inputCls}
            />
            <p className="text-[10px] text-muted-foreground/60 m-0">1 = haute, 99 = basse</p>
          </div>
        </div>
      </CardBody>
    </Card>
  )
}
