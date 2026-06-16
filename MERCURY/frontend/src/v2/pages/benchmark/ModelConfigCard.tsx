import { useState } from 'react'
import { Cpu } from 'lucide-react'
import type { ModelMetadata } from '../../../api/admin'
import { useSetBenchmarkModelMutation } from '../../../api/queries'
import { Card, CardHeader, CardBody } from '../../ui/Card'
import { Badge } from '../../ui/Badge'
import { Button } from '../../ui/Button'
import { Lbl, inputSm, selectSm } from './shared'

export function ModelConfigCard({
  selectedModel, setSelectedModel, loadedModels, modelsMeta,
}: {
  selectedModel: string
  setSelectedModel: (m: string) => void
  loadedModels: Array<{ model_id: string; ready?: boolean }>
  modelsMeta: Record<string, ModelMetadata>
}) {
  const setModelMut = useSetBenchmarkModelMutation()
  const meta = modelsMeta[selectedModel]
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<ModelMetadata>({
    display_name: '', architecture: 'dense', params_b: 0, quant: '', active_params_b: null, notes: '',
  })

  const startEdit = () => {
    if (meta) setForm({ ...meta })
    else setForm({ display_name: selectedModel, architecture: 'dense', params_b: 0, quant: '', active_params_b: null, notes: '' })
    setEditing(true)
  }
  const save = () => {
    setModelMut.mutate({ modelId: selectedModel, data: form })
    setEditing(false)
  }

  return (
    <Card>
      <CardHeader title="Modèle" icon={<Cpu size={13} />} />
      <CardBody className="flex flex-col gap-3">
        <div className="flex items-center gap-3 flex-wrap">
          <select
            className={selectSm + ' min-w-[220px]'}
            value={selectedModel}
            onChange={e => setSelectedModel(e.target.value)}
          >
            <option value="">-- Sélectionner --</option>
            {loadedModels.filter(i => i.ready).map(i => (
              <option key={i.model_id} value={i.model_id}>{i.model_id}</option>
            ))}
          </select>

          {selectedModel && meta && !editing && (
            <div className="flex items-center gap-2 flex-wrap text-[11px]">
              <span className="font-medium text-foreground">{meta.display_name}</span>
              <Badge tone={meta.architecture === 'moe' ? 'purple' : 'primary'}>
                {meta.architecture}
              </Badge>
              <span className="text-muted-foreground">
                {meta.params_b}B{meta.active_params_b ? ` (${meta.active_params_b}B actifs)` : ''}
              </span>
              <span className="font-mono text-muted-foreground">{meta.quant}</span>
              <Button size="sm" onClick={startEdit}>Modifier</Button>
            </div>
          )}

          {selectedModel && !meta && !editing && (
            <Button variant="primary" size="sm" onClick={startEdit}>
              Configurer les métadonnées
            </Button>
          )}
        </div>

        {editing && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <Lbl>Nom d'affichage</Lbl>
              <input
                className={inputSm + ' w-full mt-1'}
                value={form.display_name}
                onChange={e => setForm(f => ({ ...f, display_name: e.target.value }))}
              />
            </div>
            <div>
              <Lbl>Architecture</Lbl>
              <select
                className={selectSm + ' w-full mt-1'}
                value={form.architecture}
                onChange={e => setForm(f => ({ ...f, architecture: e.target.value as 'dense' | 'moe' }))}
              >
                <option value="dense">Dense</option>
                <option value="moe">MoE</option>
              </select>
            </div>
            <div>
              <Lbl>Params (B)</Lbl>
              <input
                type="number" step="0.1"
                className={inputSm + ' w-full mt-1'}
                value={form.params_b || ''}
                onChange={e => setForm(f => ({ ...f, params_b: parseFloat(e.target.value) || 0 }))}
              />
            </div>
            <div>
              <Lbl>Quantization</Lbl>
              <input
                className={inputSm + ' w-full mt-1'}
                value={form.quant}
                onChange={e => setForm(f => ({ ...f, quant: e.target.value }))}
                placeholder="Q5_K_M"
              />
            </div>
            {form.architecture === 'moe' && (
              <div>
                <Lbl>Params actifs (B)</Lbl>
                <input
                  type="number" step="0.1"
                  className={inputSm + ' w-full mt-1'}
                  value={form.active_params_b ?? ''}
                  onChange={e => setForm(f => ({ ...f, active_params_b: parseFloat(e.target.value) || null }))}
                />
              </div>
            )}
            <div className="col-span-full flex gap-2">
              <Button variant="primary" size="sm" onClick={save}>Enregistrer</Button>
              <Button size="sm" onClick={() => setEditing(false)}>Annuler</Button>
            </div>
          </div>
        )}
      </CardBody>
    </Card>
  )
}
