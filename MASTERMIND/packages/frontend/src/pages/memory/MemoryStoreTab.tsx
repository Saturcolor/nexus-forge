import { useState, useCallback, useEffect } from 'react';
import { api } from '../../lib/api';
import type { AgentSummary, MemoryStoreStatus, MastermindConfigResponse } from './types';
import { StoreStatusCard } from './store/StoreStatusCard';
import { StoreConfigCard } from './store/StoreConfigCard';
import { StoreImportCard } from './store/StoreImportCard';
import { StoreHealthCard } from './store/StoreHealthCard';
import { StoreEntriesCard } from './store/StoreEntriesCard';
import { StoreReasoningTracesCard } from './store/StoreReasoningTracesCard';

interface Props {
  appConfig: MastermindConfigResponse | null;
}

export function MemoryStoreTab({ appConfig }: Props) {
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [msStatus, setMsStatus] = useState<MemoryStoreStatus | null>(null);
  const [msStatusLoading, setMsStatusLoading] = useState(false);
  const [scopeFilter, setScopeFilter] = useState('all');

  const loadMsStatus = useCallback(async () => {
    setMsStatusLoading(true);
    try {
      const s = await api.get<MemoryStoreStatus>('/api/memory-store/status');
      setMsStatus(s);
    } catch (e: unknown) {
      setMsStatus({ enabled: false, reason: e instanceof Error ? e.message : String(e) });
    } finally {
      setMsStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMsStatus();
    api.get<AgentSummary[]>('/api/agents').then(setAgents).catch(() => {});
  }, [loadMsStatus]);

  const msConfigEnabled = Boolean(appConfig?.memoryStore?.enabled);
  const ms = appConfig?.memoryStore;

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-y-auto p-6 gap-5">
      <StoreStatusCard
        msStatus={msStatus}
        msStatusLoading={msStatusLoading}
        msConfigEnabled={msConfigEnabled}
        onRefresh={() => void loadMsStatus()}
        onStatusChange={() => void loadMsStatus()}
      />

      <StoreConfigCard
        initialDimensions={ms?.embeddingDimensions ?? 4096}
        initialDedup={Boolean(ms?.enableDeduplication)}
        initialDedupThreshold={ms?.deduplicationThreshold ?? 0.92}
        initialBypassSignificance={Boolean(ms?.bypassSignificanceFilter)}
        initialAutoEnabled={ms?.autoInjection?.enabled !== false}
        initialTopK={ms?.autoInjection?.topK ?? 3}
        initialThreshold={ms?.autoInjection?.threshold ?? 0.45}
        initialMaxChars={ms?.autoInjection?.maxCharsPerChunk ?? 600}
        initialIncludeShared={ms?.autoInjection?.includeShared !== false}
        msConfigEnabled={msConfigEnabled}
      />

      <StoreImportCard
        agents={agents}
        msStatus={msStatus}
        onImported={() => void loadMsStatus()}
      />

      {msStatus?.enabled && (
        <StoreHealthCard
          agents={agents}
          onConsolidated={() => void loadMsStatus()}
        />
      )}

      <StoreEntriesCard
        agents={agents}
        scopeFilter={scopeFilter}
        setScopeFilter={setScopeFilter}
      />

      <StoreReasoningTracesCard
        agents={agents}
        defaultAgentId={agents[0]?.identity.id ?? ''}
      />
    </div>
  );
}
