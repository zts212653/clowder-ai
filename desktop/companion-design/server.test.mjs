import assert from 'node:assert/strict';
import test from 'node:test';
import { startServer } from './server.mjs';

test('preview serves only declared assets on loopback and has no write or provider endpoint', async () => {
  const server = await startServer(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /屏幕、声音与模型均未连接/);
    assert.match(page.headers.get('content-security-policy'), /connect-src 'none'/);
    assert.equal((await fetch(`${base}/theme.css`)).status, 200);
    assert.equal((await fetch(`${base}/pet.webp`)).status, 200);
    assert.equal((await fetch(`${base}/.env.local`)).status, 404);
    assert.equal((await fetch(`${base}/api/messages`, { method: 'POST', body: 'sentinel' })).status, 404);
    assert.equal((await fetch(base, { method: 'POST', body: 'write' })).status, 404);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
