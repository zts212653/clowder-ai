import type { ChildProcess } from 'node:child_process';
import type { Browser } from 'puppeteer-core';

export const OWNED_BROWSER_CLOSE_TIMEOUT_MS = 5_000;
export const OWNED_BROWSER_KILL_TIMEOUT_MS = 2_000;

export type BrowserCloseReason =
  | 'launch_disconnect'
  | 'page_creation_disconnect'
  | 'session_close'
  | 'stale_handle_before_capture'
  | 'unexpected_disconnect';

export interface OwnedBrowser {
  browser: Browser;
  process: ChildProcess | null;
  launchedAtMs: number;
  exitObserved: boolean;
  closeReason: BrowserCloseReason | null;
}

type CloseOutcome = { status: 'fulfilled' } | { status: 'rejected'; error: unknown } | { status: 'timeout' };

export function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

export function processHasExited(owned: OwnedBrowser): boolean {
  if (owned.exitObserved) return true;
  if (!owned.process) return false;
  return owned.process.exitCode !== null || owned.process.signalCode !== null;
}

export function settleCloseWithin(close: Promise<void>, timeoutMs: number): Promise<CloseOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
    close.then(
      () => {
        clearTimeout(timer);
        resolve({ status: 'fulfilled' });
      },
      (error: unknown) => {
        clearTimeout(timer);
        resolve({ status: 'rejected', error });
      },
    );
  });
}

export function waitForProcessExit(owned: OwnedBrowser, timeoutMs: number): Promise<boolean> {
  const browserProcess = owned.process;
  if (!browserProcess || processHasExited(owned)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(processHasExited(owned)), timeoutMs);
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      browserProcess.off('exit', onExit);
      resolve(exited);
    };
    browserProcess.once('exit', onExit);
  });
}
