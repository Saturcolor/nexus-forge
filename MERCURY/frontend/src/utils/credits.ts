import type { CreditsReport } from '../api/admin'

export function formatCreditValue(value: number | null | undefined, asUsd = false): string {
  if (value == null || (typeof value !== 'number') || !Number.isFinite(value)) return '–'
  const n = Math.round(value * 100) / 100
  return asUsd ? `${n.toFixed(2)} USD` : String(n)
}

export type ProviderDisplay = {
  name: string
  statusClass: string
  statusText: string
  restant: number | null
  restantLabel: string
  depense30j: number | null
  depense30jLabel: string
  details: { label: string; value: string }[]
}

export function getProviderDisplayData(
  providerId: string,
  data: CreditsReport['providers'][string] | undefined,
): ProviderDisplay {
  const name = providerId.charAt(0).toUpperCase() + providerId.slice(1)
  let statusClass = 'error'
  let statusText = 'Erreur'
  let restant: number | null = null
  const restantLabel = 'Restant'
  let depense30j: number | null = null
  const depense30jLabel = 'Dépense 30j'
  const details: { label: string; value: string }[] = []

  if (!data) {
    return { name, statusClass, statusText: 'Non demandé', restant, restantLabel, depense30j, depense30jLabel, details }
  }
  if (data.ok) {
    statusClass = 'ok'
    statusText = 'OK'
    if (typeof data.remaining === 'number' && Number.isFinite(data.remaining)) restant = data.remaining
    if (providerId === 'openai' || providerId === 'anthropic') {
      if (typeof data.periodSpend === 'number' && Number.isFinite(data.periodSpend)) depense30j = data.periodSpend
    }
    if (providerId === 'openrouter') {
      if (data.totalCredits != null) details.push({ label: 'Total crédits', value: formatCreditValue(Number(data.totalCredits)) })
      if (data.totalUsage != null) details.push({ label: 'Usage', value: formatCreditValue(Number(data.totalUsage)) })
    }
    if (providerId === 'openai') {
      const openaiData = data as unknown as { creditBalance?: number; currency?: string; usage?: { period?: string } }
      if (openaiData.creditBalance != null) details.push({ label: 'Solde crédit', value: formatCreditValue(openaiData.creditBalance, true) + ' ' + (openaiData.currency || 'USD') })
      if (openaiData.usage?.period) details.push({ label: 'Période', value: String(openaiData.usage.period) })
    }
    if (providerId === 'anthropic') {
      const anthUsage = (data as unknown as { usage?: { period?: string } }).usage?.period
      if (anthUsage) details.push({ label: 'Période', value: String(anthUsage) })
    }
    if (providerId === 'elevenlabs') {
      const elData = data as unknown as { characterCount?: number; characterLimit?: number; tier?: string; status?: string }
      if (elData.characterCount != null) details.push({ label: 'Caractères utilisés', value: String(elData.characterCount).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') })
      if (elData.characterLimit != null) details.push({ label: 'Limite', value: String(elData.characterLimit).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') })
      if (elData.tier) details.push({ label: 'Tier', value: elData.tier })
      if (elData.status) details.push({ label: 'Statut', value: elData.status })
    }
  } else {
    statusText = data.error || 'Erreur'
  }
  return { name, statusClass, statusText, restant, restantLabel, depense30j, depense30jLabel, details }
}
