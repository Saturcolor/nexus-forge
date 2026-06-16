import { exec } from 'node:child_process';

export async function execBash(
  cmd: string,
  cwd: string,
  timeoutMs: number = 30_000,
): Promise<string> {
  console.log(`[bash] cwd=${cwd} cmd=${cmd.slice(0, 120)}`);
  return new Promise((resolve, reject) => {
    const _child = exec(`bash -l -c ${JSON.stringify(cmd)}`, { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err && err.killed) {
        reject(new Error(`Command timed out after ${timeoutMs}ms: ${cmd}`));
        return;
      }
      const output = [stdout, stderr].filter(Boolean).join('\n').trim();
      // Surface exec-level errors (e.g. cwd doesn't exist, shell spawn failed)
      if (!output && err) {
        console.log(`[bash] exec error: ${err.message}`);
        resolve(`Error: ${err.message}`);
        return;
      }
      const result = output || '(no output)';
      console.log(`[bash] output: ${result.slice(0, 200)}`);
      resolve(result);
    });
  });
}
