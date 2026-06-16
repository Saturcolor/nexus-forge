import { FlaskConical } from 'lucide-react'
import { ToolCall15Panel, BugFind15Panel } from '../../../components/ExtBenchPanel'
import { Card, CardHeader, CardBody } from '../../ui/Card'

/**
 * Thin V2 wrapper around the existing V1 external benchmark panels
 * (ToolCall15 + BugFind15). Embedding rather than rewriting to preserve
 * behaviour 1:1.
 */
export function ExternalBenchCard() {
  return (
    <Card>
      <CardHeader title="Benchmarks externes" icon={<FlaskConical size={13} />} />
      <CardBody className="p-0">
        <div className="flex flex-col gap-4 px-4 py-3">
          <ToolCall15Panel />
          <BugFind15Panel />
        </div>
      </CardBody>
    </Card>
  )
}
