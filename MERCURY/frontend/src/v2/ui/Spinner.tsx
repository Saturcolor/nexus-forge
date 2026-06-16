/** Inline spinner using current color — drop into any container. */
export function Spinner({ size = 14 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-current border-t-transparent"
      style={{ width: size, height: size }}
    />
  )
}

export function SpinnerInline({ label = 'Chargement…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-muted-foreground text-xs">
      <Spinner />
      <span>{label}</span>
    </div>
  )
}
