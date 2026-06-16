import fs from 'node:fs/promises';
import path from 'node:path';

export class WorkspaceMemory {
  private resolvedAgentsDir: string;
  constructor(private agentsDir: string) {
    this.resolvedAgentsDir = path.resolve(agentsDir);
    console.log(`[workspace-memory] init agentsDir=${this.resolvedAgentsDir}`);
  }

  /** Resolve a path within a workspace, rejecting traversal attempts. */
  private safePath(workspaceDir: string, filename?: string): string {
    const resolved = filename
      ? path.resolve(this.resolvedAgentsDir, workspaceDir, filename)
      : path.resolve(this.resolvedAgentsDir, workspaceDir);
    if (!resolved.startsWith(this.resolvedAgentsDir + path.sep) && resolved !== this.resolvedAgentsDir) {
      console.warn(`[workspace-memory] path traversal blocked workspace=${workspaceDir} file=${filename ?? ''} resolved=${resolved}`);
      throw new Error(`Path traversal blocked: "${workspaceDir}/${filename ?? ''}" resolves outside agents directory`);
    }
    return resolved;
  }

  /** Read a file from an agent's workspace */
  async readFile(workspaceDir: string, filename: string): Promise<string | null> {
    const filePath = this.safePath(workspaceDir, filename);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      console.debug(`[workspace-memory] readFile workspace=${workspaceDir} file=${filename} len=${content.length}`);
      return content;
    } catch (err) {
      console.warn(`[workspace-memory] readFile miss/error workspace=${workspaceDir} file=${filename}: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /** Write a file to an agent's workspace */
  async writeFile(workspaceDir: string, filename: string, content: string): Promise<void> {
    const filePath = this.safePath(workspaceDir, filename);
    console.debug(`[workspace-memory] writeFile workspace=${workspaceDir} file=${filename} len=${content.length}`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
  }

  /** List workspace files (only .md) with modification time. */
  async listFiles(workspaceDir: string): Promise<Array<{ name: string; mtime: string }>> {
    const dirPath = this.safePath(workspaceDir);
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const mdEntries = entries.filter(e => e.isFile() && e.name.endsWith('.md'));
      const results = await Promise.all(
        mdEntries.map(async e => {
          const stat = await fs.stat(path.join(dirPath, e.name)).catch(() => null);
          return { name: e.name, mtime: stat?.mtime.toISOString() ?? '' };
        })
      );
      console.debug(`[workspace-memory] listFiles workspace=${workspaceDir} files=${results.length}`);
      return results.sort((a, b) => a.name.localeCompare(b.name));
    } catch (err) {
      console.warn(`[memory] listFiles failed for workspace "${workspaceDir}" (${dirPath}):`, (err as Error).message);
      return [];
    }
  }

  /** Check if a workspace directory exists */
  async workspaceExists(workspaceDir: string): Promise<boolean> {
    const dirPath = this.safePath(workspaceDir);
    try {
      const stat = await fs.stat(dirPath);
      const exists = stat.isDirectory();
      console.debug(`[workspace-memory] workspaceExists workspace=${workspaceDir} exists=${exists}`);
      return exists;
    } catch (err) {
      console.warn(`[workspace-memory] workspaceExists workspace=${workspaceDir} missing/error: ${err instanceof Error ? err.message : err}`);
      return false;
    }
  }

  /** Get the absolute path for a workspace */
  getWorkspacePath(workspaceDir: string): string {
    const resolved = this.safePath(workspaceDir);
    console.debug(`[workspace-memory] getWorkspacePath workspace=${workspaceDir} resolved=${resolved}`);
    return resolved;
  }
}
