import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

/** A real stateless Remote listener against the real Fastify Host, isolated from runtime. */
export async function sharedRemote(app: FastifyInstance, directory: string, proSecret: string) {
  const previous = { ...process.env };
  const apiUrl = await app.listen({ port: 0, host: '127.0.0.1' });
  const keyFile = join(directory, 'existing-pro.key');
  await writeFile(keyFile, proSecret, { mode: 0o600 });
  Object.assign(process.env, {
    CAT_CAFE_API_URL: apiUrl,
    CAT_CAFE_REMOTE_TOKEN: 'existing-installed-connection',
    CAT_CAFE_AGENT_KEY_FILES: JSON.stringify({ 'gpt-pro': keyFile }),
    CAT_CAFE_AGENT_KEY_BOUND_CAT_ID: 'gpt-pro',
    CAT_CAFE_CAT_ID: 'gpt-pro',
    CAT_CAFE_READONLY: 'true',
    CAT_CAFE_DESKTOP_MODE: 'cloud-pro-phase0',
  });
  delete process.env.CAT_CAFE_INVOCATION_ID;
  delete process.env.CAT_CAFE_CALLBACK_TOKEN;
  const { handleMcpRequest, wrapResponseWithRedact } = await import('../../../mcp-server/src/remote-spike.js');
  const server = createServer((req, res) => void handleMcpRequest(req, wrapResponseWithRedact(res)));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    rpc: async (method: string, params: unknown = {}) => {
      const response = await fetch(`http://127.0.0.1:${address.port}/mcp?token=existing-installed-connection`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'mcp-protocol-version': '2026-07-28',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      const data = text.startsWith('event:') ? text.split('data: ')[1] : text;
      assert.ok(data);
      return JSON.parse(data);
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    },
  };
}
