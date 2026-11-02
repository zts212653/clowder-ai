import { createServer } from 'node:http';
import { expect, it, vi } from 'vitest';
import { requestPluginHttp } from '../plugin-panel-http';

const transport = vi.hoisted(() => vi.fn());
vi.mock('@/utils/api-client', () => ({ apiFetch: transport }));

it('does not follow a plugin 307 into another Host endpoint with owner credentials', async () => {
  let writes = 0;
  const server = createServer((request, response) => {
    if (request.url === '/api/plugins/dev.fixture/redirect') {
      response.writeHead(307, { location: '/api/core/write' });
      response.end();
      return;
    }
    if (
      request.url === '/api/core/write' &&
      request.method === 'POST' &&
      request.headers.cookie === 'fixture-owner=authenticated' &&
      request.headers['x-csrf-token'] === 'fixture-csrf'
    )
      writes++;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('fixture HTTP server unavailable');
  transport.mockImplementation((path: string, input: RequestInit) =>
    fetch(`http://127.0.0.1:${address.port}${path}`, {
      ...input,
      headers: { ...input.headers, cookie: 'fixture-owner=authenticated', 'x-csrf-token': 'fixture-csrf' },
    }),
  );
  try {
    const outcome = await requestPluginHttp(
      { pluginId: 'dev.fixture', instanceId: 'fixture', generation: 'activation' },
      { method: 'POST', path: 'redirect', body: { op: 'write' } },
    ).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    expect(writes).toBe(0);
    expect(outcome).toHaveProperty('error');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    transport.mockReset();
  }
});
