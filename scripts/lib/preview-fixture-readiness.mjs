import { setTimeout as delay } from 'node:timers/promises';

/** Test-only barrier: launch acceptance or an open port does not prove fixture setup finished. */
export async function waitForPreviewFixture({ port, expectedBody, deadline, diagnostics }) {
  let observation = 'no response before the startup deadline';
  while (performance.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(500, Math.ceil(deadline - performance.now())))),
      });
      const body = await response.text();
      if (response.ok && body === expectedBody && performance.now() < deadline) return;
      observation = `HTTP ${response.status}: ${body.slice(0, 200)}`;
    } catch (error) {
      observation = error.message;
    }
    const remaining = deadline - performance.now();
    if (remaining > 0) await delay(Math.min(100, remaining));
  }
  throw new Error(`Preview fixture did not become ready within the startup deadline: ${observation}\n${diagnostics()}`);
}
