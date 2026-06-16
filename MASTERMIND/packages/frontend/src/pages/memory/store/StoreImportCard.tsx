import { useState } from 'react';
import { Upload, Loader2 } from 'lucide-react';
import { api } from '../../../lib/api';
import { cardCls, inputCls, btnPrimary } from '../types';
import type { AgentSummary, MemoryImportResult, MemoryStoreStatus } from '../types';

interface Props {
  agents: AgentSummary[];
  msStatus: MemoryStoreStatus | null;
  onImported: () => void;
}

export function StoreImportCard({ agents, msStatus, onImported }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [target, setTarget] = useState(agents[0]?.identity.id ?? 'shared');
  const [domain, setDomain] = useState('');
  const [dryRun, setDryRun] = useState(false);
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<MemoryImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleImport = async () => {
    if (!file) return;
    setImporting(true);
    setError(null);
    setResult(null);
    try {
      const fd = new FormData();
      fd.append('file', file);
      if (target === 'shared') {
        fd.append('scope', 'shared');
      } else {
        fd.append('scope', 'agent');
        fd.append('agentId', target);
      }
      if (domain.trim()) fd.append('domain', domain.trim());
      if (dryRun) fd.append('dryRun', 'true');
      const r = await api.upload<MemoryImportResult>('/api/memory-store/import', fd);
      setResult(r);
      if (!dryRun) onImported();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className={cardCls}>
      <h2 className="text-sm font-semibold text-foreground flex items-center gap-2 mb-4">
        <Upload size={16} /> Importer un fichier .md
      </h2>

      <div className="space-y-3">
        <div>
          <label className="text-xs text-muted-foreground block mb-1">Fichier Markdown</label>
          <input
            type="file" accept=".md,.txt"
            onChange={e => { setFile(e.target.files?.[0] ?? null); setResult(null); }}
            className="text-xs text-foreground file:mr-3 file:px-3 file:py-1 file:rounded-lg file:border-0 file:bg-secondary file:text-foreground file:text-xs cursor-pointer"
          />
        </div>

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="col-span-2 sm:col-span-1">
            <label className="text-xs text-muted-foreground block mb-1">Cible</label>
            <select value={target} onChange={e => setTarget(e.target.value)} className={inputCls}>
              <option value="shared">shared (partage)</option>
              {agents.map(a => (
                <option key={a.identity.id} value={a.identity.id}>{a.identity.name ?? a.identity.id}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground block mb-1">Domaine</label>
            <input value={domain} onChange={e => setDomain(e.target.value)} placeholder="ex: decisions" className={inputCls} />
          </div>
          <div className="flex items-end pb-1.5">
            <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
              <input type="checkbox" checked={dryRun} onChange={e => setDryRun(e.target.checked)} className="rounded" />
              Dry-run (simulation)
            </label>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button type="button" disabled={!file || importing || !msStatus?.enabled} onClick={() => void handleImport()} className={btnPrimary}>
            {importing ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}
            {importing ? 'Import en cours...' : dryRun ? 'Simuler' : 'Importer'}
          </button>
          {!msStatus?.enabled && <span className="text-xs text-muted-foreground">Memory store non active</span>}
        </div>

        {error && <p className="text-xs text-theme-red">{error}</p>}
        {result && (
          <div className="bg-secondary rounded-lg p-3 text-xs space-y-1">
            <div className="font-medium text-foreground">{dryRun ? 'Simulation terminee' : 'Import termine'}</div>
            <div className="text-theme-green">{result.imported} chunk(s) importe(s)</div>
            <div className="text-muted-foreground">{result.skippedInsignificant} ignore(s) (non significatif)</div>
            <div className="text-muted-foreground">{result.skippedDuplicate} ignore(s) (doublon)</div>
            <div className="text-muted-foreground">Total analyse : {result.total}</div>
          </div>
        )}
      </div>
    </div>
  );
}
