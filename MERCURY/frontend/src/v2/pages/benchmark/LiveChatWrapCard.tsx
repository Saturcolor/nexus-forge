import { Radio } from 'lucide-react'
import LiveChatCard from '../../../components/LiveChatCard'
import { Card, CardHeader, CardBody } from '../../ui/Card'

/**
 * Thin V2 wrapper around the existing V1 LiveChatCard.
 * LiveChatCard is a self-contained 700+ line component; rather than risk
 * behaviour drift, we embed it under the V2 Card surface.
 */
export function LiveChatWrapCard({ selectedModel }: { selectedModel: string }) {
  return (
    <Card>
      <CardHeader title="Chat en direct" icon={<Radio size={13} />} />
      <CardBody className="p-0">
        <div className="px-4 py-3">
          <LiveChatCard selectedModel={selectedModel} />
        </div>
      </CardBody>
    </Card>
  )
}
