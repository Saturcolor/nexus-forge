import DiskUsageBar from './models/DiskUsageBar'
import SearchCard from './models/SearchCard'
import QueueCard from './models/QueueCard'
import LocalModelsCard from './models/LocalModelsCard'
import EmbeddingChainCard from './models/EmbeddingChainCard'
import TokenCard from './models/TokenCard'

export default function ModelsPanel() {
  return (
    <div className="flex flex-col gap-4 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-white m-0">Models</h1>
        <DiskUsageBar />
      </header>
      <SearchCard />
      <QueueCard />
      <LocalModelsCard />
      <EmbeddingChainCard />
      <TokenCard />
    </div>
  )
}
