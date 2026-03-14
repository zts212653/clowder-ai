import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { getAntigravitySmokeSkipReason, runAntigravityRoundTripSmoke } from './helpers/antigravity-smoke.js';

// Skip entire suite if Antigravity is not running on port 9000
async function isAntigravityRunning() {
  try {
    const resp = await fetch('http://<local-browser-automation-endpoint>/json/version', {
      signal: AbortSignal.timeout(2000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

const running = await isAntigravityRunning();
const skipReason = getAntigravitySmokeSkipReason({
  env: process.env,
  runtimeReachable: running,
});

describe('Antigravity smoke test', { skip: skipReason ?? false }, () => {
  test('CDP connect → send → receive round trip', { timeout: 90_000 }, async () => {
    const { AntigravityCdpClient } = await import(
      '../dist/domains/cats/services/agents/providers/antigravity/AntigravityCdpClient.js'
    );
    const client = new AntigravityCdpClient({ port: 9000 });
    const response = await runAntigravityRoundTripSmoke(client);

    assert.ok(response, 'should receive a response');
    assert.ok(response.toLowerCase().includes('pong'), `response should contain "pong", got: ${response}`);

    await client.disconnect();
  });

  test('AntigravityAgentService invoke yields text + done', { timeout: 90_000 }, async () => {
    const { AntigravityAgentService } = await import(
      '../dist/domains/cats/services/agents/providers/antigravity/AntigravityAgentService.js'
    );
    const service = new AntigravityAgentService({
      catId: 'antigravity',
      model: 'gemini-3.1-pro',
      cdpPort: 9000,
    });
    const messages = [];
    for await (const msg of service.invoke('Reply with just "meow"')) {
      messages.push(msg);
    }

    assert.ok(messages.length >= 2, 'should have at least text + done');
    const textMsg = messages.find((m) => m.type === 'text');
    assert.ok(textMsg, 'should have a text message');
    assert.ok(textMsg.content, 'text message should have content');
    assert.equal(messages[messages.length - 1].type, 'done');
  });
});
