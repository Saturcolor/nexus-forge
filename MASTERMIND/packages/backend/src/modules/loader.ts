import type { Module, ModuleRegistry } from '@mastermind/shared';

export class ModuleLoader implements ModuleRegistry {
  private modules = new Map<string, Module>();

  register(module: Module): void {
    console.debug(`[modules] register ${module.name}`);
    this.modules.set(module.name, module);
  }

  get<T extends Module>(name: string): T {
    const mod = this.modules.get(name);
    if (!mod) {
      console.warn(`[modules] get missing ${name}`);
      throw new Error(`Module "${name}" not found`);
    }
    console.debug(`[modules] get ${name}`);
    return mod as T;
  }

  tryGet<T extends Module>(name: string): T | undefined {
    const mod = this.modules.get(name) as T | undefined;
    console.debug(`[modules] tryGet ${name} found=${!!mod}`);
    return mod;
  }

  getAll(): Module[] {
    const all = Array.from(this.modules.values());
    console.debug(`[modules] getAll count=${all.length}`);
    return all;
  }

  async destroyAll(): Promise<void> {
    for (const mod of this.modules.values()) {
      if (mod.destroy) {
        console.log(`[modules] destroyAll ${mod.name}`);
        await mod.destroy();
        console.log(`[modules] destroyAll ${mod.name} ok`);
      }
    }
  }
}
