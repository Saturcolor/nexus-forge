import { useEffect, useState } from 'react'
import { clsx } from 'clsx'
import { RefreshCw, Cpu, Lock, LockOpen } from 'lucide-react'
import { useCacheModels } from '../../../api/queries'
import * as api from '../../../api/admin'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Spinner } from '../../ui/Spinner'

export function LoadedModelsCard() {
  const { data, refetch } = useCacheModels()
  const [refreshing, setRefreshing] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Forcer un refresh du cache côté serveur au montage — fidèle à V1.
  useEffect(() => {
    api.refreshModelsCache().then(() => refetch()).catch(() => { /* ignore */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const loaded = (data?.models || []).filter(m => m.loaded)
  const protectedNames = new Set(data?.protected_model_names || [])

  const toggleProtect = (name: string, isProtected: boolean) => {
    setBusy(name)
    setError(null)
    api.setProtectedModel(name, !isProtected)
      .then(() => refetch())
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(null))
  }

  const handleRefresh = () => {
    setRefreshing(true)
    api.refreshModelsCache()
      .then(() => refetch())
      .finally(() => setRefreshing(false))
  }

  return (
    <Card>
      <CardHeader
        title="Modèles chargés"
        icon={<Cpu size={13} />}
        subtitle={`${loaded.length} détecté${loaded.length > 1 ? 's' : ''}`}
        right={
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Rafraîchir le cache modèles"
          >
            {refreshing ? <Spinner size={11} /> : <RefreshCw size={12} />}
          </Button>
        }
      />
      <CardBody className="!py-3">
        {loaded.length === 0 ? (
          <p className="text-[11px] text-muted-foreground/60 m-0">Aucun modèle détecté.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {loaded.map(m => {
              const isProtected = protectedNames.has(m.name)
              return (
                <Badge key={m.name} tone="success" mono>
                  <span className="w-1.5 h-1.5 rounded-full bg-theme-green" />
                  {m.name}
                  <button
                    type="button"
                    onClick={() => toggleProtect(m.name, isProtected)}
                    disabled={busy === m.name}
                    title={isProtected
                      ? "Épinglé : protégé de l'unload du scheduler — cliquer pour désépingler"
                      : "Épingler : garder ce modèle chargé pendant les schedules (jamais unload)"}
                    className={clsx(
                      'ml-1 -mr-0.5 transition-opacity disabled:opacity-40',
                      isProtected ? 'text-primary opacity-100' : 'opacity-50 hover:opacity-100',
                    )}
                  >
                    {isProtected ? <Lock size={10} /> : <LockOpen size={10} />}
                  </button>
                </Badge>
              )
            })}
          </div>
        )}
        {error && (
          <p className="mt-2 text-[11px] text-destructive m-0">Épinglage échoué : {error}</p>
        )}
      </CardBody>
    </Card>
  )
}
