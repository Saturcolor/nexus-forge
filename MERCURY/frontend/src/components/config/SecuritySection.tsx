import { inputClass, labelClass, fieldClass, sectionClass, legendClass, type SectionProps } from './shared'
import Checkbox from './Checkbox'

type SecuritySectionProps = SectionProps & {
  adminTokenSet: boolean
  requireAuth: boolean
  setRequireAuth: (v: boolean) => void
  adminTokenInput: string
  setAdminTokenInput: (v: string) => void
}

export default function SecuritySection({ config, updateField, markDirty, adminTokenSet, requireAuth, setRequireAuth, adminTokenInput, setAdminTokenInput }: SecuritySectionProps) {
  return (
    <section className={sectionClass}>
      <h3 className="text-lg font-semibold text-white border-b border-neutral-800 pb-2">Securite & Acces</h3>

      <fieldset className="border-0 p-0 m-0 flex flex-col gap-4">
        <legend className={legendClass}>Authentification admin</legend>
        <Checkbox
          id="cfg-require-auth"
          checked={requireAuth}
          onChange={e => { markDirty(); setRequireAuth(e.target.checked) }}
          label="Token admin requis"
          tooltip="Exiger un token pour acceder aux routes /admin (dashboard et API d'administration)."
        />
        {requireAuth && (
          <div className={fieldClass}>
            <label htmlFor="cfg-admin-token" className={labelClass}>Token admin</label>
            <input
              id="cfg-admin-token"
              type="password"
              value={adminTokenInput}
              onChange={e => { markDirty(); setAdminTokenInput(e.target.value) }}
              placeholder={adminTokenSet ? '•••••••• (vide = ne pas changer)' : 'Saisir le token'}
              autoComplete="off"
              className={inputClass}
            />
          </div>
        )}
      </fieldset>

      <fieldset className="border-0 p-0 m-0 flex flex-col gap-4">
        <legend className={legendClass}>Controle d'acces API</legend>
        <Checkbox
          id="cfg-admin-accept-user-key"
          checked={config.admin_accept_user_api_key !== false}
          onChange={e => updateField('admin_accept_user_api_key', e.target.checked)}
          label="Accepter les cles users sur /admin"
          tooltip="Permet d'utiliser un token utilisateur (users[].api_key) pour les routes /admin/*, en plus du token admin."
        />
        <Checkbox
          id="cfg-require-api-key"
          checked={config.require_api_key === true}
          onChange={e => updateField('require_api_key', e.target.checked)}
          label="Cle API requise"
          tooltip="Exiger une cle API pour /v1/chat/completions ; les requetes sans cle ou avec cle inconnue recoivent 401."
        />
        <div className={fieldClass}>
          <label htmlFor="cfg-anonymous-priority" className={labelClass}>Priorite anonyme</label>
          <input
            id="cfg-anonymous-priority"
            type="number"
            value={config.anonymous_priority ?? 99}
            min={1}
            max={999}
            className={inputClass}
            onChange={e => updateField('anonymous_priority', Number(e.target.value))}
            title="Priorite dans la file pour les utilisateurs sans cle API (1 = haute, 99 = basse)"
          />
          <p className="text-xs text-neutral-500">Priorite dans la file pour les requetes sans cle API (1 = haute, 99 = basse).</p>
        </div>
      </fieldset>
    </section>
  )
}
