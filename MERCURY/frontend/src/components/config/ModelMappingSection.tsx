import { useState, useCallback, useEffect } from 'react'
import type { ModelMappingResponse } from '../../api/admin'
import * as api from '../../api/admin'
import { sectionClass } from './shared'

type ModelMappingSectionProps = {
  configLoaded: boolean
  refreshKey: number
}

export default function ModelMappingSection({ configLoaded, refreshKey }: ModelMappingSectionProps) {
  const [modelMapping, setModelMapping] = useState<ModelMappingResponse | null>(null)
  const [backendModelsOpen, setBackendModelsOpen] = useState(false)

  const loadModelMapping = useCallback(async () => {
    try { setModelMapping(await api.getModelMapping()) } catch { setModelMapping(null) }
  }, [])

  useEffect(() => {
    if (configLoaded) loadModelMapping()
  }, [configLoaded, loadModelMapping, refreshKey])

  return (
    <section className={sectionClass}>
      <h3 className="text-lg font-semibold text-white border-b border-neutral-800 pb-2">Mapping des modeles</h3>
      <p className="text-xs text-neutral-500 m-0">Utilisez « Rafraichir le cache » dans la tuile Cache pour mettre a jour.</p>
      <div className="flex flex-col gap-4">
        {modelMapping ? (
          <>
            <h4 className="text-sm font-medium text-neutral-400 mb-3">Resolutions des modeles</h4>
            <div className="overflow-x-auto bg-neutral-900 border border-neutral-800 rounded-lg">
              <table className="w-full text-left border-collapse text-xs">
                <thead>
                  <tr>
                    <th className="p-3 bg-neutral-950 font-medium text-neutral-400 border-b border-neutral-800">Nom canonique</th>
                    <th className="p-3 bg-neutral-950 font-medium text-neutral-400 border-b border-neutral-800">Backend</th>
                    <th className="p-3 bg-neutral-950 font-medium text-neutral-400 border-b border-neutral-800">ID backend</th>
                  </tr>
                </thead>
                <tbody>
                  {modelMapping.from_config.map((row, i) => (
                    <tr key={`config-${i}`}>
                      <td className="p-3 border-b border-neutral-800/50 text-neutral-200"><code>{row.canonical}</code></td>
                      <td className="p-3 border-b border-neutral-800/50 text-neutral-200">{row.backend}</td>
                      <td className="p-3 border-b border-neutral-800/50 text-neutral-200"><code>{row.backend_model_id}</code></td>
                    </tr>
                  ))}
                  {modelMapping.from_cache.filter(r => !modelMapping.from_config.some(c => c.canonical === r.canonical)).map((row, i) => (
                    <tr key={`cache-${i}`}>
                      <td className="p-3 border-b border-neutral-800/50 text-neutral-200"><code>{row.canonical}</code></td>
                      <td className="p-3 border-b border-neutral-800/50 text-neutral-200">{row.backend}</td>
                      <td className="p-3 border-b border-neutral-800/50 text-neutral-200"><code>{row.backend_model_id}</code></td>
                    </tr>
                  ))}
                  {modelMapping.from_config.length === 0 && modelMapping.from_cache.length === 0 && (
                    <tr><td colSpan={3} className="p-3 text-neutral-500">Aucune resolution (les requetes alimenteront le cache en memoire).</td></tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="flex flex-col gap-2">
              {modelMapping.backend_models.length === 0 ? (
                <p className="text-sm text-neutral-500 m-0">Aucun modele en cache. Rafraichir le cache.</p>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setBackendModelsOpen(o => !o)}
                    className="text-sm font-medium text-neutral-400 hover:text-neutral-200 flex items-center gap-1.5 w-fit text-left"
                  >
                    {backendModelsOpen ? '▼' : '▶'} Modeles des backends ({modelMapping.backend_models.length})
                  </button>
                  <p className="text-xs text-neutral-500 m-0">Liste brute issue du cache (tous les noms connus par backend). Repliable pour alleger la page.</p>
                  {backendModelsOpen && (
                    <div className="overflow-x-auto bg-neutral-900 border border-neutral-800 rounded-lg max-h-[min(420px,50vh)] overflow-y-auto">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead className="sticky top-0 z-[1]">
                          <tr>
                            <th className="p-3 bg-neutral-950 font-medium text-neutral-400 border-b border-neutral-800">Nom</th>
                            <th className="p-3 bg-neutral-950 font-medium text-neutral-400 border-b border-neutral-800">Backend</th>
                            <th className="p-3 bg-neutral-950 font-medium text-neutral-400 border-b border-neutral-800">ID backend</th>
                            <th className="p-3 bg-neutral-950 font-medium text-neutral-400 border-b border-neutral-800">Cle normalisee</th>
                          </tr>
                        </thead>
                        <tbody>
                          {modelMapping.backend_models.map((row, i) => (
                            <tr key={i}>
                              <td className="p-3 border-b border-neutral-800/50 text-neutral-200"><code>{row.name}</code></td>
                              <td className="p-3 border-b border-neutral-800/50 text-neutral-200">{row.backend}</td>
                              <td className="p-3 border-b border-neutral-800/50 text-neutral-200"><code>{row.backend_model_id}</code></td>
                              <td className="p-3 border-b border-neutral-800/50 text-neutral-500"><code>{row.normalized}</code></td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        ) : (
          <p className="text-sm text-neutral-500 m-0">Aucune donnee. Cliquez sur « Rafraichir le cache » dans la tuile Cache.</p>
        )}
      </div>
    </section>
  )
}
