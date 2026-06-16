type OrderableListProps = {
  items: string[]
  onChange: (items: string[]) => void
  labels: Record<string, string>
}

export default function OrderableList({ items, onChange, labels }: OrderableListProps) {
  const move = (index: number, direction: -1 | 1) => {
    const next = [...items]
    const target = index + direction
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-1">
      {items.map((item, i) => (
        <div key={item} className="flex items-center gap-2 px-3 py-1.5 bg-neutral-950 border border-neutral-800 rounded-md text-sm text-neutral-200">
          <span className="text-neutral-500 text-xs font-mono w-4 text-center">{i + 1}</span>
          <span className="flex-1">{labels[item] ?? item}</span>
          <button
            type="button"
            disabled={i === 0}
            onClick={() => move(i, -1)}
            className="px-1.5 py-0.5 text-xs text-neutral-400 hover:text-white disabled:opacity-25 disabled:cursor-default transition-colors"
            title="Monter"
          >
            ▲
          </button>
          <button
            type="button"
            disabled={i === items.length - 1}
            onClick={() => move(i, 1)}
            className="px-1.5 py-0.5 text-xs text-neutral-400 hover:text-white disabled:opacity-25 disabled:cursor-default transition-colors"
            title="Descendre"
          >
            ▼
          </button>
        </div>
      ))}
    </div>
  )
}
