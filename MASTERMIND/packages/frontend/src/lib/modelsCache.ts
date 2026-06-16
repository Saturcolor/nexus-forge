import { api } from './api';
import type { LiveModel } from '../pages/agents/types';

const cache = new Map<string, { models: LiveModel[]; ts: number }>();
const TTL_MS = 60_000;

export async function fetchExposedModels(providerId: string, force = false): Promise<LiveModel[]> {
  const entry = cache.get(providerId);
  if (!force && entry && Date.now() - entry.ts < TTL_MS) {
    return entry.models;
  }
  const models = await api.get<LiveModel[]>(`/api/providers/${providerId}/exposed-models`);
  cache.set(providerId, { models, ts: Date.now() });
  return models;
}

export function getCachedModels(providerId: string): LiveModel[] | null {
  const entry = cache.get(providerId);
  if (!entry) return null;
  if (Date.now() - entry.ts >= TTL_MS) return null;
  return entry.models;
}
