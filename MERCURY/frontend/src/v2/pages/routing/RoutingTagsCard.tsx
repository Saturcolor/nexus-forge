import { Tag } from 'lucide-react'
import { Card, CardHeader, CardBody } from '../../ui/Card'

const ROUTING_TAGS: { tag: string; description: string }[] = [
  { tag: 'lm_studio/lm_studio ou lmstudio/lmstudio', description: 'Premier modèle LM Studio' },
  { tag: 'ollama/ollama',                            description: 'Premier modèle Ollama' },
  { tag: 'llamacpp/llamacpp',                        description: 'Premier modèle llama.cpp' },
  { tag: 'vllm/vllm',                                description: 'Premier modèle vLLM' },
  { tag: 'lucebox/lucebox',                          description: 'Premier modèle Lucebox' },
  { tag: 'mlx/mlx',                                  description: 'Premier modèle MLX' },
]

/** Reference table — auto-routing tags users can put in the `model` field. */
export function RoutingTagsCard() {
  return (
    <Card>
      <CardHeader
        title="Tags pour routage"
        subtitle="Identifiants à utiliser dans le champ model pour router vers le bon provider (premier modèle du backend)."
        icon={<Tag size={13} />}
      />
      <CardBody className="!py-3">
        <div className="overflow-x-auto rounded-md border border-border/60">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-background/40">
                <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-widest border-b border-border/60">
                  Tag à utiliser
                </th>
                <th className="px-3 py-2 text-[10px] font-medium text-muted-foreground uppercase tracking-widest border-b border-border/60">
                  Comportement
                </th>
              </tr>
            </thead>
            <tbody>
              {ROUTING_TAGS.map(({ tag, description }) => (
                <tr key={tag} className="hover:bg-background/40">
                  <td className="px-3 py-1.5 border-b border-border/40">
                    <code className="text-[11px] font-mono text-primary">{tag}</code>
                  </td>
                  <td className="px-3 py-1.5 border-b border-border/40 text-[11px] text-foreground">
                    {description}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardBody>
    </Card>
  )
}
