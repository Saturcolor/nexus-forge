import type { Module, MastermindContext } from '@mastermind/shared';
import { WorkspaceMemory } from './workspace.js';
import { SharedMemory } from './shared.js';
import { DailyMemory } from './daily.js';

export class MemoryModule implements Module {
  name = 'memory';
  workspace!: WorkspaceMemory;
  shared!: SharedMemory;
  daily!: DailyMemory;

  async init(ctx: MastermindContext): Promise<void> {
    const startedAt = Date.now();
    console.log('[memory] init start');
    const configMod = ctx.modules.get<import('../config/index.js').ConfigModule>('config');
    const agentsDir = configMod.resolvePath(ctx.config.paths.agentsDir);
    const sharedDir = configMod.resolvePath(ctx.config.paths.sharedMemoryDir);

    this.workspace = new WorkspaceMemory(agentsDir);
    this.shared = new SharedMemory(sharedDir);
    this.daily = new DailyMemory(sharedDir);

    console.log(`[memory] Agents dir: ${agentsDir}`);
    console.log(`[memory] Shared dir: ${sharedDir}`);
    if (ctx.config.paths.skillsDir) {
      console.log(`[memory] Skills dir: ${configMod.resolvePath(ctx.config.paths.skillsDir)}`);
    }
    console.log(`[memory] init done ms=${Date.now() - startedAt}`);
  }
}
