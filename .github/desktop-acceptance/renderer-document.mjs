import { setTimeout as delay } from 'node:timers/promises';

/** A CDP target URL can precede its document's navigation commit. */
export async function waitForRendererDocument({ read, origin, now = Date.now, pause = delay, timeoutMs = 60000 }) {
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    let state;
    try {
      state = await read();
    } catch {
      // Navigation can replace the execution context while readiness is read.
    }
    if (state?.origin === origin && state.readyState === 'complete' && state.hasBody === true) return state;
    await pause(100);
  }
  throw new Error('Installed Electron document did not become ready at the expected origin');
}
