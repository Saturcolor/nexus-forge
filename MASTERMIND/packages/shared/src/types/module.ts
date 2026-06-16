import type { Pool } from 'pg';
import type { MastermindConfig } from './config.js';

export interface WebSocketManager {
  broadcast(room: string, data: unknown): void;
  broadcastAll(data: unknown): void;
  /**
   * Nombre de clients qui REGARDENT activement une session (premier plan + écran chat visible) —
   * presence pour le dedup de push. Exposé sur l'interface car des modules hors du cœur delivery
   * (ex async-jobs) en ont besoin pour honorer `presenceDedup`.
   */
  hasSessionViewers(sessionId: string): number;
}

export interface ModuleRegistry {
  get<T extends Module>(name: string): T;
  tryGet<T extends Module>(name: string): T | undefined;
  register(module: Module): void;
  getAll(): Module[];
}

export interface MastermindContext {
  config: MastermindConfig;
  db: Pool;
  ws: WebSocketManager;
  modules: ModuleRegistry;
}

export interface Module {
  name: string;
  init(ctx: MastermindContext): Promise<void>;
  destroy?(): Promise<void>;
}
