import type { ChildProcess } from 'child_process';
import * as fs from 'fs';

const DEFAULT_RM_RETRIES = 20;
const DEFAULT_RM_DELAY_MS = 50;
const DEFAULT_CHILD_EXIT_TIMEOUT_MS = 5000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableRmError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === 'EPERM' || code === 'EBUSY' || code === 'ENOTEMPTY';
}

export async function rmDirWithRetries(dir: string | undefined): Promise<void> {
  if (!dir) return;

  for (let attempt = 0; attempt <= DEFAULT_RM_RETRIES; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (!isRetriableRmError(err) || attempt === DEFAULT_RM_RETRIES) {
        throw err;
      }
      await delay(DEFAULT_RM_DELAY_MS * (attempt + 1));
    }
  }
}

export async function waitForChildExit(
  child: ChildProcess,
  timeoutMs = DEFAULT_CHILD_EXIT_TIMEOUT_MS,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off('exit', finish);
      child.off('close', finish);
      resolve();
    };
    const timer = setTimeout(finish, timeoutMs);
    timer.unref?.();
    child.once('exit', finish);
    child.once('close', finish);
  });
}

export async function killChildAndWait(
  child: ChildProcess | null | undefined,
  timeoutMs = DEFAULT_CHILD_EXIT_TIMEOUT_MS,
): Promise<void> {
  if (!child) return;
  try { child.stdin?.destroy(); } catch { /* best-effort */ }
  if (child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  await waitForChildExit(child, timeoutMs);
}
