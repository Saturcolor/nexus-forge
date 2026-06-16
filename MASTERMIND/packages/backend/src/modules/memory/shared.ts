import fs from 'node:fs/promises';
import path from 'node:path';

export class SharedMemory {
  /** Absolute path to the shared memory directory */
  readonly dir: string;

  constructor(sharedDir: string) {
    this.dir = path.resolve(sharedDir);
    console.log(`[shared-memory] init dir=${this.dir}`);
  }

  /** Resolve a relative path within the shared directory, rejecting traversal attempts. */
  private safePath(relativePath: string): string {
    const resolved = path.resolve(this.dir, relativePath);
    if (!resolved.startsWith(this.dir + path.sep) && resolved !== this.dir) {
      console.warn(`[shared-memory] path traversal blocked rel="${relativePath}" resolved=${resolved}`);
      throw new Error(`Path traversal blocked: "${relativePath}" resolves outside shared directory`);
    }
    return resolved;
  }

  /** Write a file to shared memory (creates directories as needed) */
  async writeFile(relativePath: string, content: string): Promise<void> {
    const filePath = this.safePath(relativePath);
    console.debug(`[shared-memory] writeFile path=${relativePath} len=${content.length}`);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf-8');
  }

  /** Read a file from shared memory */
  async readFile(relativePath: string): Promise<string | null> {
    const filePath = this.safePath(relativePath);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      console.debug(`[shared-memory] readFile path=${relativePath} len=${content.length}`);
      return content;
    } catch (err) {
      console.warn(`[shared-memory] readFile miss/error path=${relativePath}: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /** Read and concatenate all MD files in a directory */
  async readDir(relativePath: string): Promise<string | null> {
    const dirPath = this.safePath(relativePath);
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const mdFiles = entries.filter(e => e.isFile() && e.name.endsWith('.md'));
      if (mdFiles.length === 0) {
        console.debug(`[shared-memory] readDir path=${relativePath} mdFiles=0`);
        return null;
      }

      const contents: string[] = [];
      for (const file of mdFiles) {
        const content = await fs.readFile(path.join(dirPath, file.name), 'utf-8');
        contents.push(`## ${file.name}\n${content}`);
      }
      console.debug(`[shared-memory] readDir path=${relativePath} mdFiles=${mdFiles.length} chars=${contents.reduce((sum, x) => sum + x.length, 0)}`);
      return contents.join('\n\n');
    } catch (err) {
      console.warn(`[shared-memory] readDir failed path=${relativePath}: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /** List entries in shared memory with mtime */
  async listDir(relativePath: string = ''): Promise<Array<{ name: string; isDir: boolean; mtime?: string }>> {
    const dirPath = relativePath ? this.safePath(relativePath) : this.dir;
    try {
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      const listed = await Promise.all(entries.map(async e => {
        const stat = await fs.stat(path.join(dirPath, e.name)).catch(() => null);
        return { name: e.name, isDir: e.isDirectory(), mtime: stat?.mtime.toISOString() };
      }));
      console.debug(`[shared-memory] listDir path=${relativePath || '.'} entries=${listed.length}`);
      return listed;
    } catch (err) {
      console.warn(`[shared-memory] listDir failed path=${relativePath || '.'}: ${err instanceof Error ? err.message : err}`);
      return [];
    }
  }
}
