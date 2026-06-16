import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState } from 'react'
import * as api from './admin'
import type { LlamaTiming } from './admin'

export const QUERY_KEYS = {
  version: ['version'],
  config: ['config'],
  queue: ['queue'],
  backends: ['backends'],
  recentLogs: ['logs', 'recent'],
  cacheModels: ['cacheModels'],
  cacheState: ['cacheState'],
  stats: (date?: string) => ['stats', date],
  statsRange: (days: number, bucket: string) => ['statsRange', days, bucket],
  logs: (date?: string) => ['logs', date],
  dates: ['dates'],
  users: ['users'],
  credits: (providers?: string[]) => ['credits', providers?.join(',')],
  creditsTotals: (providers?: string[]) => ['creditsTotals', providers?.join(',')],
  lmStudioModels: ['lmStudioModels'],
  lmStudioProbe: ['lmStudioProbe'],
  ollamaProbe: ['ollamaProbe'],
  hostStats: ['hostStats'],
  modelMapping: ['modelMapping'],
  openRouterModels: ['openRouterModels'],
  debug: ['debug'],
  ollamaModels: ['ollamaModels'],
  ollamaPs: ['ollamaPs'],
  llamacppModels: ['llamacppModels'],
  llamacppProbe: ['llamacppProbe'],
  llamacppTemplates: ['llamacppTemplates'],
  llamacppDaemonLogs: ['llamacppDaemonLogs'],
  llamacppSlots: (modelId: string) => ['llamacppSlots', modelId],
  llamacppDaemonVersion: ['llamacppDaemonVersion'],
  atlasPresets: (modelId?: string) => ['atlasPresets', modelId ?? null],
  brainThermal: ['brainThermal'],
  brainPerf: ['brainPerf'],
  brainUpdater: ['brainUpdater'],
  luceboxUpdater: ['luceboxUpdater'],
  luceboxUpdaterLog: ['luceboxUpdaterLog'],
  brainSettings: ['brainSettings'],
  brainMemory: ['brainMemory'],
  brainMemoryEvents: ['brainMemoryEvents'],
  benchmarkPresets: ['benchmarkPresets'],
  benchmarkResults: ['benchmarkResults'],
  benchmarkModels: ['benchmarkModels'],
  convTemplates: ['convTemplates'],
  audioVoices: ['audioVoices'],
  openRouterHealth: ['openRouterHealth'],
  atlasHealth: ['atlasHealth'],
  hfSearch: (key: string) => ['hfSearch', key],
  hfRepoFiles: (repoId: string) => ['hfRepoFiles', repoId],
  hfJobs: ['hfJobs'],
  hfToken: ['hfToken'],
  hfDisk: ['hfDisk'],
  schedules: ['schedules'],
  scheduleHistory: ['scheduleHistory'],
}

// === Queries ===

export function useVersion() {
  return useQuery({
    queryKey: QUERY_KEYS.version,
    queryFn: api.getVersion,
    refetchInterval: 60000,
  })
}

export function useConfig() {
  return useQuery({
    queryKey: QUERY_KEYS.config,
    queryFn: api.getConfig,
    refetchInterval: 10000,
  })
}

export function useQueue() {
  return useQuery({
    queryKey: QUERY_KEYS.queue,
    queryFn: api.getQueue,
    refetchInterval: 2000,
  })
}

export function useBackends() {
  return useQuery({
    queryKey: QUERY_KEYS.backends,
    queryFn: api.getBackends,
    refetchInterval: 60000, // Reduced from 3600000 for better responsiveness, could be tweaked
  })
}

export function useLmStudioProbe(enabled: boolean) {
  return useQuery({
    queryKey: QUERY_KEYS.lmStudioProbe,
    queryFn: api.getLmStudioProbe,
    refetchInterval: 15000,
    enabled,
  })
}

export function useOllamaProbe(enabled: boolean) {
  return useQuery({
    queryKey: QUERY_KEYS.ollamaProbe,
    queryFn: api.getOllamaProbe,
    refetchInterval: 15000,
    enabled,
  })
}

export function useHostStats() {
  return useQuery({
    queryKey: QUERY_KEYS.hostStats,
    queryFn: api.getHostStats,
    refetchInterval: 2000,
    retry: false,
  })
}

export function useLlamacppDaemonVersion(enabled: boolean) {
  return useQuery({
    queryKey: QUERY_KEYS.llamacppDaemonVersion,
    queryFn: api.getLlamacppDaemonVersion,
    refetchInterval: enabled ? 60000 : false,
    enabled,
    retry: false,
  })
}

export function useRecentLogs() {
  return useQuery({
    queryKey: QUERY_KEYS.recentLogs,
    queryFn: () => api.getLogs(),
    refetchInterval: 3000,
  })
}

export function useCacheModels() {
  return useQuery({
    queryKey: QUERY_KEYS.cacheModels,
    queryFn: api.getCacheModels,
    refetchInterval: 60000,
  })
}

export function useAudioVoices() {
  return useQuery({
    queryKey: QUERY_KEYS.audioVoices,
    queryFn: api.getAudioVoices,
    refetchInterval: 60000,
  })
}

export function useCacheState() {
  return useQuery({
    queryKey: QUERY_KEYS.cacheState,
    queryFn: api.getCacheState,
    refetchInterval: 60000,
  })
}

export function useLmStudioModels() {
  return useQuery({
    queryKey: QUERY_KEYS.lmStudioModels,
    queryFn: api.getLmStudioModels,
  })
}

export function useLogs(date?: string | null) {
  return useQuery({
    queryKey: QUERY_KEYS.logs(date ?? undefined),
    queryFn: () => api.getLogs(date ?? undefined),
    refetchInterval: 5000,
  })
}

export function useStats(date?: string | null) {
  return useQuery({
    queryKey: QUERY_KEYS.stats(date ?? undefined),
    queryFn: () => api.getStats(date ?? undefined),
    refetchInterval: 5000,
  })
}

export function useStatsRange(days: number, bucket: 'day' | 'hour') {
  return useQuery({
    queryKey: QUERY_KEYS.statsRange(days, bucket),
    queryFn: () => api.getStatsRange(days, bucket),
    refetchInterval: 30000,
  })
}

export function useDates() {
  return useQuery({
    queryKey: QUERY_KEYS.dates,
    queryFn: api.getDates,
    refetchInterval: 30000,
  })
}

export function useUsers() {
  return useQuery({
    queryKey: QUERY_KEYS.users,
    queryFn: api.getUsers,
  })
}

export function useModelMapping(enabled = true) {
  return useQuery({
    queryKey: QUERY_KEYS.modelMapping,
    queryFn: api.getModelMapping,
    enabled,
  })
}

// === Mutations ===

export function useCancelQueueMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.cancelCurrentQueueRequest,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.queue })
    },
  })
}

export function useRefreshCacheMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.refreshModelsCache,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.cacheModels })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.cacheState })
    },
  })
}

export function useFlushCacheMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.flushModelsCache,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.cacheModels })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.cacheState })
    },
  })
}

export function useSaveConfigMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.saveConfig,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.config })
      // La config impacte l'affichage des providers + la "stats machine" (HostStatsCard).
      // Sans invalidation, l'UI peut afficher des éléments jusqu'au prochain refetchInterval.
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.backends })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.hostStats })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.lmStudioProbe })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.ollamaProbe })
    },
  })
}

export function useSetProviderPriorityMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.setProviderPriority,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.backends })
    },
  })
}

export function useSetCloudFallbackOrderMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.setCloudFallbackOrder,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.config })
    },
  })
}

export function useSetModelPriorityMutation() {
  return useMutation({
    mutationFn: api.setModelPriority,
  })
}

export function useSetHiddenModelMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ modelName, hidden }: { modelName: string; hidden: boolean }) =>
      api.setHiddenModel(modelName, hidden),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.cacheModels })
    },
  })
}

export function useSetModelCategoryMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ modelName, category }: { modelName: string; category: string | null }) =>
      api.setModelCategory(modelName, category),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.cacheModels })
    },
  })
}

export function useLoadLmStudioModelMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.loadLmStudioModel,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.lmStudioModels })
    },
  })
}

export function useUnloadLmStudioModelMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.unloadLmStudioModel,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.lmStudioModels })
    },
  })
}

export function useInjectLmStudioPromptMutation() {
  return useMutation({
    mutationFn: api.injectLmStudioPrompt,
  })
}

// === Ollama ===

export function useOllamaModels() {
  return useQuery({
    queryKey: QUERY_KEYS.ollamaModels,
    queryFn: api.getOllamaModels,
    refetchInterval: 30000,
  })
}

export function useOllamaPs() {
  return useQuery({
    queryKey: QUERY_KEYS.ollamaPs,
    queryFn: api.getOllamaPs,
    refetchInterval: 10000,
  })
}

export function useLoadOllamaModelMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.loadOllamaModel,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.ollamaModels })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.ollamaPs })
    },
  })
}

export function useUnloadOllamaModelMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.unloadOllamaModel,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.ollamaModels })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.ollamaPs })
    },
  })
}

export function useDeleteOllamaModelMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.deleteOllamaModel,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.ollamaModels })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.ollamaPs })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.cacheModels })
    },
  })
}

// === LlamaCPP ===

export function useLlamacppModels() {
  return useQuery({
    queryKey: QUERY_KEYS.llamacppModels,
    queryFn: api.getLlamacppModels,
    refetchInterval: 15000,
    retry: false,
  })
}

export function useLlamacppProbe(enabled: boolean) {
  return useQuery({
    queryKey: QUERY_KEYS.llamacppProbe,
    queryFn: api.getLlamacppProbe,
    refetchInterval: 15000,
    enabled,
    retry: false,
  })
}

export function useLlamacppTemplates() {
  return useQuery({
    queryKey: QUERY_KEYS.llamacppTemplates,
    queryFn: api.getLlamacppTemplates,
    retry: false,
  })
}

export function useLoadLlamacppModelMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.loadLlamacppModel,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.llamacppModels })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.llamacppProbe })
    },
  })
}

export function useUnloadLlamacppModelMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.unloadLlamacppModel,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.llamacppModels })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.llamacppProbe })
    },
  })
}

// === AtlasMind presets ===

export function useAtlasPresets(modelId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: QUERY_KEYS.atlasPresets(modelId),
    queryFn: () => api.getAtlasPresets(modelId),
    enabled: enabled && Boolean(modelId),
    retry: false,
    staleTime: 30_000,
  })
}

/** Tous les presets exportables (pas de filtre modèle) — utilisé pour étiqueter
 *  les LoRA indexés sur les cards. Hook distinct car useAtlasPresets exige un
 *  modelId (guard `Boolean(modelId)`), ce qui bloquerait le fetch global. */
export function useAllAtlasPresets(enabled = true) {
  return useQuery({
    queryKey: QUERY_KEYS.atlasPresets(undefined),
    queryFn: () => api.getAtlasPresets(undefined),
    enabled,
    retry: false,
    staleTime: 60_000,
  })
}

export function useApplyAtlasPresetMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (args: { model_id: string; preset_id: number }) =>
      api.applyAtlasPreset(args.model_id, args.preset_id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.llamacppModels })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.llamacppProbe })
    },
  })
}

/** Multi-select : applique N presets en stack (concat des LoRAs côté brain).
 *  preset_ids vide → backend renvoie 400, use clearAtlasPreset. */
export function useApplyAtlasPresetsMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (args: { model_id: string; preset_ids: number[] }) =>
      api.applyAtlasPresets(args.model_id, args.preset_ids),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.llamacppModels })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.llamacppProbe })
    },
  })
}

export function useClearAtlasPresetMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (model_id: string) => api.clearAtlasPreset(model_id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.llamacppModels })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.llamacppProbe })
    },
  })
}

export function useSaveKvCacheMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (model_id: string) => api.saveLlamacppKvCache(model_id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.llamacppModels })
    },
  })
}

export function useDeleteKvCacheMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (model_id: string) => api.deleteLlamacppKvCache(model_id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.llamacppModels })
    },
  })
}

export function useSetLlamacppTemplateMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ model_id, template }: { model_id: string; template: api.LlamacppTemplate }) =>
      api.setLlamacppTemplate(model_id, template),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.llamacppTemplates })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.llamacppModels })
    },
  })
}

export function useDeleteLlamacppTemplateMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: api.deleteLlamacppTemplate,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.llamacppTemplates })
      queryClient.invalidateQueries({ queryKey: QUERY_KEYS.llamacppModels })
    },
  })
}

export function useLlamacppDaemonLogs(enabled: boolean) {
  return useQuery({
    queryKey: QUERY_KEYS.llamacppDaemonLogs,
    queryFn: () => api.getLlamacppDaemonLogs(200),
    refetchInterval: enabled ? 3000 : false,
    enabled,
    retry: false,
  })
}

export function useLlamacppSlots(modelId: string, enabled: boolean) {
  return useQuery({
    queryKey: QUERY_KEYS.llamacppSlots(modelId),
    queryFn: () => api.getLlamacppSlots(modelId),
    refetchInterval: enabled ? 2000 : false,
    enabled,
    retry: false,
  })
}

// ── Brain Management ─────────────────────────────────────────────────────────

export function useBrainThermal(enabled = true) {
  return useQuery({
    queryKey: QUERY_KEYS.brainThermal,
    queryFn: api.getBrainThermalStatus,
    refetchInterval: enabled ? 2000 : false,
    enabled,
    retry: false,
  })
}

export function useBrainPerf(enabled = true) {
  return useQuery({
    queryKey: QUERY_KEYS.brainPerf,
    queryFn: api.getBrainPerfStatus,
    refetchInterval: enabled ? 5000 : false,
    enabled,
    retry: false,
  })
}

export function useBrainUpdater(enabled = true) {
  return useQuery({
    queryKey: QUERY_KEYS.brainUpdater,
    queryFn: api.getBrainUpdaterStatus,
    refetchInterval: enabled ? 10000 : false,
    enabled,
    retry: false,
  })
}

/** Lucebox sub-updater status. Refetch bump à 2s tant que in_progress=true
 *  (git fetch + build), retombe à 30s sinon (économise les git-fetch réseau). */
export function useLuceboxUpdater(enabled = true) {
  return useQuery({
    queryKey: QUERY_KEYS.luceboxUpdater,
    queryFn: api.getLuceboxUpdaterStatus,
    refetchInterval: (q) => {
      if (!enabled) return false
      const data = q.state.data
      return data?.in_progress ? 2000 : 30000
    },
    enabled,
    retry: false,
  })
}

/** Lucebox log buffer, poll 1s quand active. Désactiver hors panel ouvert. */
export function useLuceboxUpdaterLog(enabled = true) {
  return useQuery({
    queryKey: QUERY_KEYS.luceboxUpdaterLog,
    queryFn: api.getLuceboxUpdaterLog,
    refetchInterval: enabled ? 1000 : false,
    enabled,
    retry: false,
  })
}

export function useLuceboxUpdateMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.postLuceboxUpdate,
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.luceboxUpdater }) },
  })
}

export function useLuceboxBuildMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.postLuceboxBuild,
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.luceboxUpdater }) },
  })
}

export function useBrainThermalStartMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.postBrainThermalStart,
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.brainThermal }) },
  })
}

export function useBrainThermalStopMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.postBrainThermalStop,
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.brainThermal }) },
  })
}

export function useBrainThermalConfigMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.postBrainThermalConfig,
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.brainThermal }) },
  })
}

export function useBrainPerfModeMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (mode: string) => api.postBrainPerfMode(mode),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.brainPerf }) },
  })
}

export function useBrainPerfCustomMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (overrides: { stapm_w?: number | null; tctl_c?: number | null }) => api.postBrainPerfCustom(overrides),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.brainPerf }) },
  })
}

export function useBrainUpdaterActionMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ action, backend }: { action: string; backend: string }) =>
      api.postBrainUpdaterAction(action, backend),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.brainUpdater }) },
  })
}

export function useBrainRebootMutation() {
  return useMutation({
    mutationFn: api.postBrainReboot,
  })
}

export function useOpenRouterHealth(enabled = true) {
  return useQuery({
    queryKey: QUERY_KEYS.openRouterHealth,
    queryFn: api.getOpenRouterHealth,
    enabled,
    refetchInterval: enabled ? 15000 : false,
    retry: false,
  })
}

export function useAtlasHealth(enabled = true) {
  return useQuery({
    queryKey: QUERY_KEYS.atlasHealth,
    queryFn: api.getAtlasHealth,
    enabled,
    refetchInterval: enabled ? 5000 : false,
    retry: false,
  })
}

export function useBrainSettings(enabled = true) {
  return useQuery({
    queryKey: QUERY_KEYS.brainSettings,
    queryFn: api.getBrainSettings,
    enabled,
    retry: false,
  })
}

export function useSaveBrainSettingsMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.saveBrainSettings,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.brainSettings })
      qc.invalidateQueries({ queryKey: QUERY_KEYS.brainThermal })
      qc.invalidateQueries({ queryKey: QUERY_KEYS.brainPerf })
    },
  })
}

// ── Brain Memory Management ─────────────────────────────────────────────────

export function useBrainMemoryStatus(enabled = true) {
  return useQuery({
    queryKey: QUERY_KEYS.brainMemory,
    queryFn: api.getBrainMemoryStatus,
    refetchInterval: enabled ? 2000 : false,
    enabled,
    retry: false,
  })
}

export function useBrainMemoryEvents(enabled = true) {
  return useQuery({
    queryKey: QUERY_KEYS.brainMemoryEvents,
    queryFn: api.getBrainMemoryEvents,
    refetchInterval: enabled ? 10000 : false,
    enabled,
    retry: false,
  })
}

export function useBrainMemoryStartMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.postBrainMemoryStart,
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.brainMemory }) },
  })
}

export function useBrainMemoryStopMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.postBrainMemoryStop,
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.brainMemory }) },
  })
}

export function useBrainMemoryConfigMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.patchBrainMemoryConfig,
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.brainMemory }) },
  })
}

export function useBrainMemoryProtectMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.postBrainMemoryProtect,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.brainMemory })
      qc.invalidateQueries({ queryKey: QUERY_KEYS.llamacppModels })
    },
  })
}

export function useBrainMemoryUnprotectMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.postBrainMemoryUnprotect,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.brainMemory })
      qc.invalidateQueries({ queryKey: QUERY_KEYS.llamacppModels })
    },
  })
}

export function useBrainMemorySwapClearMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.postBrainMemorySwapClear,
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.brainMemory }) },
  })
}

export function useBrainMemoryEvictMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.postBrainMemoryEvict,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.brainMemory })
      qc.invalidateQueries({ queryKey: QUERY_KEYS.llamacppProbe })
    },
  })
}

// ── Parsing timing lines ─────────────────────────────────────────────────────
// Format réel llama-server récent — 3 lignes séparées sans préfixe,
// après une ligne "slot print_timing: id X | task Y |" :
//   "prompt eval time =  491099.88 ms / 171648 tokens (... 349.52 tokens per second)"
//   "       eval time =    6471.60 ms /   160 tokens (...  24.72 tokens per second)"
//   "      total time =  497571.48 ms / 171808 tokens"

function parseLlamaTiming(line: string): Partial<LlamaTiming> | null {
  // "prompt eval time = ..."
  const promptMatch = line.match(
    /prompt eval time\s*=\s*([\d.]+)\s+ms\s*\/\s*(\d+)\s+tokens.*?([\d.]+)\s+tokens per second/
  )
  if (promptMatch) {
    return {
      promptEvalMs: parseFloat(promptMatch[1]),
      promptTokens: parseInt(promptMatch[2], 10),
      promptTokensPerSecond: parseFloat(promptMatch[3]),
    }
  }
  // "       eval time = ..." (espaces en début de ligne)
  const evalMatch = line.match(
    /^\s+eval time\s*=\s*([\d.]+)\s+ms\s*\/\s*(\d+)\s+(?:tokens|runs).*?([\d.]+)\s+tokens per second/
  )
  if (evalMatch) {
    return {
      evalMs: parseFloat(evalMatch[1]),
      evalTokens: parseInt(evalMatch[2], 10),
      evalTokensPerSecond: parseFloat(evalMatch[3]),
    }
  }
  // "      total time = ..." → déclenche l'émission du timing complet
  const totalMatch = line.match(
    /^\s*total time\s*=\s*([\d.]+)\s+ms\s*\/\s*(\d+)\s+tokens/
  )
  if (totalMatch) {
    return {
      totalMs: parseFloat(totalMatch[1]),
      totalTokens: parseInt(totalMatch[2], 10),
    }
  }
  // Format legacy avec préfixe llama_print_timings:
  const lp = line.match(/llama_print_timings:\s+prompt eval time\s+=\s+([\d.]+)\s+ms\s+\/\s+(\d+)\s+tokens.*?([\d.]+)\s+tokens per second/)
  if (lp) return { promptEvalMs: parseFloat(lp[1]), promptTokens: parseInt(lp[2], 10), promptTokensPerSecond: parseFloat(lp[3]) }
  const le = line.match(/llama_print_timings:\s+eval time\s+=\s+([\d.]+)\s+ms\s+\/\s+(\d+)\s+runs.*?([\d.]+)\s+tokens per second/)
  if (le) return { evalMs: parseFloat(le[1]), evalTokens: parseInt(le[2], 10), evalTokensPerSecond: parseFloat(le[3]) }
  const lt = line.match(/llama_print_timings:\s+total time\s+=\s+([\d.]+)\s+ms\s+\/\s+(\d+)\s+tokens/)
  if (lt) return { totalMs: parseFloat(lt[1]), totalTokens: parseInt(lt[2], 10) }

  return null
}

const MAX_INSTANCE_LOG_LINES = 200

export type InstanceLogState = {
  lines: string[]
  lastTiming: LlamaTiming | null
  connected: boolean
  error: string | null
}

/**
 * Hook SSE pour les logs d'une instance llama-server en temps réel.
 * Utilise fetch+ReadableStream pour supporter les headers Authorization.
 * Parse llama_print_timings pour extraire les métriques de génération.
 */
export function useLlamacppInstanceLogs(modelId: string, enabled: boolean): InstanceLogState {
  const [state, setState] = useState<InstanceLogState>({
    lines: [],
    lastTiming: null,
    connected: false,
    error: null,
  })
  const pendingTimingRef = useRef<Partial<LlamaTiming>>({})

  useEffect(() => {
    if (!enabled || !modelId) return
    const controller = new AbortController()

    // Récupère le token admin depuis le localStorage (même clé que clientFetch — cf. ADMIN_TOKEN_KEY dans admin.ts)
    const token = (() => {
      try { return localStorage.getItem('mercury_admin_token') } catch { return null }
    })()
    const headers: Record<string, string> = { Accept: 'text/event-stream' }
    if (token) headers['Authorization'] = `Bearer ${token}`

    ;(async () => {
      try {
        const resp = await fetch(`/admin/llamacpp/logs-stream/${modelId}`, {
          headers,
          signal: controller.signal,
        })
        if (!resp.ok || !resp.body) {
          setState(s => ({ ...s, error: `HTTP ${resp.status}`, connected: false }))
          return
        }
        setState(s => ({ ...s, connected: true, error: null }))
        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          while (buffer.includes('\n\n')) {
            const idx = buffer.indexOf('\n\n')
            const frame = buffer.slice(0, idx).trim()
            buffer = buffer.slice(idx + 2)
            if (!frame || frame.startsWith(':')) continue  // keepalive
            for (const rawLine of frame.split('\n')) {
              if (!rawLine.startsWith('data:')) continue
              const payload = rawLine.slice(5).trim()
              try {
                const parsed = JSON.parse(payload) as { log?: string; error?: string }
                if (parsed.error) {
                  setState(s => ({ ...s, error: parsed.error ?? null }))
                  continue
                }
                const logLine = parsed.log ?? ''
                setState(s => {
                  const lines = [...s.lines, logLine]
                  return { ...s, lines: lines.length > MAX_INSTANCE_LOG_LINES ? lines.slice(-MAX_INSTANCE_LOG_LINES) : lines }
                })
                const fragment = parseLlamaTiming(logLine)
                if (fragment) {
                  pendingTimingRef.current = { ...pendingTimingRef.current, ...fragment }
                  if (pendingTimingRef.current.totalMs !== undefined) {
                    const full = { ...pendingTimingRef.current } as LlamaTiming
                    pendingTimingRef.current = {}
                    setState(s => ({ ...s, lastTiming: full }))
                  }
                }
              } catch { /* ignore JSON parse errors */ }
            }
          }
        }
      } catch (e: unknown) {
        if ((e as { name?: string }).name !== 'AbortError') {
          setState(s => ({ ...s, error: String(e), connected: false }))
        }
      } finally {
        setState(s => ({ ...s, connected: false }))
      }
    })()

    return () => {
      controller.abort()
      setState({ lines: [], lastTiming: null, connected: false, error: null })
    }
  }, [modelId, enabled])

  return state
}

// === Benchmark ===

export function useBenchmarkPresets() {
  return useQuery({
    queryKey: QUERY_KEYS.benchmarkPresets,
    queryFn: api.getBenchmarkPresets,
  })
}

export function useBenchmarkResults() {
  return useQuery({
    queryKey: QUERY_KEYS.benchmarkResults,
    queryFn: api.getBenchmarkResults,
    refetchInterval: 10000,
  })
}

export function useBenchmarkModels() {
  return useQuery({
    queryKey: QUERY_KEYS.benchmarkModels,
    queryFn: api.getBenchmarkModels,
    refetchInterval: 30000,
  })
}

export function useRunBenchmarkMutation() {
  return useMutation({ mutationFn: api.runBenchmark })
}

export function useRunBenchmarkSuiteMutation() {
  return useMutation({ mutationFn: api.runBenchmarkSuite })
}

export function useSaveBenchmarkResultMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.saveBenchmarkResult,
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.benchmarkResults }) },
  })
}

export function useUpdateBenchmarkResultMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, updates }: { id: string; updates: Partial<api.BenchmarkResult> }) =>
      api.updateBenchmarkResult(id, updates),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.benchmarkResults }) },
  })
}

export function useDeleteBenchmarkResultMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.deleteBenchmarkResult,
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.benchmarkResults }) },
  })
}

export function useSetBenchmarkModelMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ modelId, data }: { modelId: string; data: api.ModelMetadata }) =>
      api.setBenchmarkModel(modelId, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.benchmarkModels }) },
  })
}

export function useConvTemplates() {
  return useQuery({
    queryKey: QUERY_KEYS.convTemplates,
    queryFn: api.getConvTemplates,
  })
}

export function useSetConvTemplateMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: api.ConvTemplate }) =>
      api.setConvTemplate(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.convTemplates }) },
  })
}

export function useDeleteConvTemplateMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.deleteConvTemplate,
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.convTemplates }) },
  })
}

// ── Models / Downloader (HuggingFace) ────────────────────────────────────────

export function useHfSearch(params: api.HfSearchParams, enabled: boolean) {
  const key = JSON.stringify({
    q: params.q?.trim() ?? '',
    author: params.author?.trim() ?? '',
    sort: params.sort ?? 'downloads',
    ggufOnly: params.ggufOnly ?? true,
  })
  const hasQuery = (params.q?.trim().length ?? 0) >= 2
  const hasAuthor = (params.author?.trim().length ?? 0) >= 2
  return useQuery({
    queryKey: QUERY_KEYS.hfSearch(key),
    queryFn: () => api.searchHfModels(params),
    enabled: enabled && (hasQuery || hasAuthor),
    staleTime: 60_000,
    retry: false,
  })
}

export function useHfRepoFiles(repoId: string, enabled: boolean) {
  return useQuery({
    queryKey: QUERY_KEYS.hfRepoFiles(repoId),
    queryFn: () => api.listHfRepoFiles(repoId),
    enabled: enabled && !!repoId,
    staleTime: 5 * 60_000,
    retry: false,
  })
}

export function useHfJobs() {
  return useQuery({
    queryKey: QUERY_KEYS.hfJobs,
    queryFn: api.listHfJobs,
    // Poll 1.5s quand un job est actif/en queue, sinon 10s.
    refetchInterval: (query) => {
      const jobs = query.state.data
      if (!jobs) return 10_000
      const active = jobs.some(j => j.state === 'queued' || j.state === 'running')
      return active ? 1500 : 10_000
    },
    retry: false,
  })
}

export function useHfToken() {
  return useQuery({
    queryKey: QUERY_KEYS.hfToken,
    queryFn: api.getHfToken,
    refetchInterval: 60_000,
    retry: false,
  })
}

export function useHfDisk() {
  return useQuery({
    queryKey: QUERY_KEYS.hfDisk,
    queryFn: api.getHfDiskUsage,
    refetchInterval: 10_000,
    retry: false,
  })
}

export function useStartHfDownloadMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.startHfDownload,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.hfJobs })
      qc.invalidateQueries({ queryKey: QUERY_KEYS.hfDisk })
    },
  })
}

export function useStartHfDownloadBatchMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (body: { repo_id: string; filenames: string[] }) => {
      return Promise.all(body.filenames.map(fn => api.startHfDownload({ repo_id: body.repo_id, filename: fn })))
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.hfJobs })
      qc.invalidateQueries({ queryKey: QUERY_KEYS.hfDisk })
    },
  })
}

export function useCancelHfJobMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.cancelHfJob,
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.hfJobs }) },
  })
}

export function useSetHfTokenMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.setHfToken,
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.hfToken }) },
  })
}

export function useDeleteLocalModelMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.deleteLocalModel,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.hfDisk })
      qc.invalidateQueries({ queryKey: QUERY_KEYS.llamacppModels })
    },
  })
}

// --- Scheduler ---

export function useSchedules() {
  return useQuery({
    queryKey: QUERY_KEYS.schedules,
    queryFn: api.getSchedules,
    refetchInterval: 5000,
  })
}

export function useScheduleHistory() {
  return useQuery({
    queryKey: QUERY_KEYS.scheduleHistory,
    queryFn: api.getScheduleHistory,
    refetchInterval: 10000,
  })
}

export function useCreateScheduleMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.createSchedule,
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.schedules }) },
  })
}

export function useUpdateScheduleMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<api.ModelSchedule> }) => api.updateSchedule(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.schedules }) },
  })
}

export function useDeleteScheduleMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.deleteSchedule,
    onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.schedules }) },
  })
}

export function useTriggerScheduleMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.triggerSchedule,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.schedules })
      qc.invalidateQueries({ queryKey: QUERY_KEYS.scheduleHistory })
    },
  })
}

export function useDeactivateSlotMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: api.deactivateSlot,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QUERY_KEYS.schedules })
      qc.invalidateQueries({ queryKey: QUERY_KEYS.scheduleHistory })
    },
  })
}
