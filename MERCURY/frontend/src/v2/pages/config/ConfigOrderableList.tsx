import { ChevronUp, ChevronDown } from 'lucide-react'

type Props = {
  items: string[]
  onChange: (items: string[]) => void
  labels: Record<string, string>
}

export function ConfigOrderableList({ items, onChange, labels }: Props) {
  const move = (index: number, dir: -1 | 1) => {
    const next = [...items]
    const t = index + dir
    if (t < 0 || t >= next.length) return
    ;[next[index], next[t]] = [next[t], next[index]]
    onChange(next)
  }

  return (
    <div className="flex flex-col gap-1">
      {items.map((item, i) => (
        <div key={item} className="flex items-center gap-2 px-2.5 py-1.5 bg-background border border-border/60 rounded-md">
          <span className="text-[9px] text-muted-foreground/50 font-mono w-3 text-center shrink-0">{i + 1}</span>
          <span className="flex-1 text-[11px] text-foreground">{labels[item] ?? item}</span>
          <button type="button" disabled={i === 0} onClick={() => move(i, -1)}
            className="p-0.5 text-muted-foreground/60 hover:text-foreground disabled:opacity-20 disabled:cursor-default transition-colors">
            <ChevronUp size={12} />
          </button>
          <button type="button" disabled={i === items.length - 1} onClick={() => move(i, 1)}
            className="p-0.5 text-muted-foreground/60 hover:text-foreground disabled:opacity-20 disabled:cursor-default transition-colors">
            <ChevronDown size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
