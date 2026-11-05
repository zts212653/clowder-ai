import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { nativeTool } from './helpers/native-music-tool.js';

for (const failure of ['timeout', 'abort'] as const) {
  test(
    `${failure} closes the native fixture before rejection, including an ignored SIGTERM and open HTTP request`,
    { timeout: 10_000 },
    async () => {
      let requested!: () => void;
      const received = new Promise<void>((resolve) => {
        requested = resolve;
      });
      const server = createServer(() => requested());
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address();
      assert.ok(address && typeof address !== 'string');
      let pid: number | undefined;
      const controller = new AbortController();
      try {
        const pending = nativeTool(
          process.execPath,
          [
            '-e',
            "process.on('SIGTERM', () => {}); require('node:http').get(process.env.F327_FIXTURE_URL, () => {}); process.stdin.resume();",
          ],
          { F327_FIXTURE_URL: `http://127.0.0.1:${address.port}` },
          {},
          {
            timeoutMs: failure === 'timeout' ? 1000 : 5000,
            signal: controller.signal,
            onSpawn: (value) => {
              pid = value;
            },
          },
        );
        await Promise.race([received, pending]);
        if (failure === 'abort') controller.abort();
        await assert.rejects(pending, failure === 'timeout' ? /native_fixture_timeout/ : /native_fixture_aborted/);
        assert.ok(pid);
        const closedPid = pid;
        assert.throws(() => process.kill(closedPid, 0), { code: 'ESRCH' });
      } finally {
        if (pid) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch (error) {
            assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
          }
        }
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
      assert.equal(server.listening, false);
    },
  );
}
