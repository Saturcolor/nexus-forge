import type { ReactNode } from 'react'

/**
 * Higher-level group of TemplateSections with a header like
 * "Options de démarrage (load)" or "Valeurs par défaut (defaults — ...)".
 *
 *   <TemplateSectionGroup title="Options de démarrage (load)">
 *     <TemplateSection ...>
 *   </TemplateSectionGroup>
 */
export default function TemplateSectionGroup({
  title,
  children,
}: {
  title: string
  children: ReactNode
}) {
  return (
    <div className="space-y-4">
      <p className="text-[11px] font-semibold text-neutral-500 uppercase tracking-wider">{title}</p>
      {children}
    </div>
  )
}
