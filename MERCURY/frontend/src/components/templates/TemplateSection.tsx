import type { ReactNode } from 'react'
import { sectionTitle } from './shared'

type Cols = 1 | 2 | 3 | 4

const colsClass: Record<Cols, string> = {
  1: 'grid grid-cols-1 gap-3',
  2: 'grid grid-cols-2 sm:grid-cols-2 gap-3',
  3: 'grid grid-cols-2 sm:grid-cols-3 gap-3',
  4: 'grid grid-cols-2 sm:grid-cols-4 gap-3',
}

/**
 * Titled sub-block of a template editor section (e.g. "Contexte & GPU").
 *
 *   <TemplateSection title="Contexte & GPU" cols={4}>
 *     <NumberField ... />
 *     <BooleanField ... />
 *   </TemplateSection>
 */
export default function TemplateSection({
  title,
  cols = 4,
  children,
}: {
  title: string
  cols?: Cols
  children: ReactNode
}) {
  return (
    <div>
      <p className={sectionTitle}>{title}</p>
      <div className={colsClass[cols]}>{children}</div>
    </div>
  )
}
