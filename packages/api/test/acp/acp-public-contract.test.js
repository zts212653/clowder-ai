import assert from 'node:assert/strict';
import { test } from 'node:test';
import { imageFixture } from '../helpers/acp-image-fixture.js';

const init = (capabilities, version = 1) => ({
  protocolVersion: version,
  authMethods: [],
  agentInfo: { name: 'fixture', title: 'Fixture', version: '1' },
  agentCapabilities: capabilities,
});
const remote = { type: 'http', name: 'required', url: 'http://example.invalid/mcp', headers: [] };
for (const transport of ['stdio', 'http']) {
  test(`${transport}: rejects incompatible protocol before sessions`, async () => {
    const fixture = await imageFixture(transport, '/fixture', { initializeResult: init({}, 2) }).catch(
      (error) => error,
    );
    if (fixture.client) await fixture.close();
    assert.ok(fixture instanceof Error);
    assert.match(fixture.message, /protocol|version/i);
  });
  test(`${transport}: complete capabilities are independent of the returned initialize object`, async () => {
    const fixture = await imageFixture(transport, '/fixture', {
      initializeResult: init({ loadSession: true, mcpCapabilities: { http: true } }),
    });
    try {
      fixture.initialized.agentCapabilities.mcpCapabilities.http = false;
      await fixture.client.newSession('/fixture', [remote]);
      assert.equal(fixture.captured.find((packet) => packet.method === 'session/new').params.mcpServers.length, 1);
    } finally {
      await fixture.close();
    }
  });
  test(`${transport}: unsupported required MCP transport is rejected without a session`, async () => {
    const fixture = await imageFixture(transport, '/fixture', {
      initializeResult: init({ loadSession: true, mcpCapabilities: { http: false } }),
    });
    try {
      await assert.rejects(
        fixture.client.newSession('/fixture', [remote], { requiredMcpServers: ['required'] }),
        /MCP|transport/i,
      );
      assert.equal(fixture.captured.filter((packet) => packet.method === 'session/new').length, 0);
    } finally {
      await fixture.close();
    }
  });
  test(`${transport}: chooses negotiated resume instead of trying unsupported load`, async () => {
    const fixture = await imageFixture(transport, '/fixture', {
      initializeResult: init({ loadSession: false, sessionCapabilities: { resume: {} } }),
    });
    try {
      await fixture.client.loadSession('owned', '/fixture');
      assert.equal(fixture.captured.filter((packet) => packet.method === 'session/load').length, 0);
      assert.equal(fixture.captured.filter((packet) => packet.method === 'session/resume').length, 1);
    } finally {
      await fixture.close();
    }
  });
  test(`${transport}: no declared restore method means no trial request`, async () => {
    const fixture = await imageFixture(transport, '/fixture', { initializeResult: init({ loadSession: false }) });
    try {
      await assert.rejects(fixture.client.loadSession('owned', '/fixture'), /restore|resume|load/i);
      assert.equal(fixture.captured.filter((packet) => packet.method.startsWith('session/')).length, 0);
    } finally {
      await fixture.close();
    }
  });
  test(`${transport}: restore cannot substitute a different native session`, async () => {
    const fixture = await imageFixture(transport, '/fixture', { sessionResult: { sessionId: 'foreign' } });
    try {
      await assert.rejects(fixture.client.loadSession('owned', '/fixture'), /session|identity/i);
    } finally {
      await fixture.close();
    }
  });
  test(`${transport}: native instruction requirement cannot be silently ignored`, async () => {
    const fixture = await imageFixture(transport, '/fixture');
    try {
      await assert.rejects(
        fixture.client.newSession('/fixture', [], {
          instructions: { revision: 'r1', entries: [{ role: 'system', content: 'Synthetic trusted marker' }] },
        }),
        /instruction|role|unsupported/i,
      );
      assert.equal(fixture.captured.filter((packet) => packet.method === 'session/new').length, 0);
    } finally {
      await fixture.close();
    }
  });
  test(`${transport}: set config retains its readback instead of returning void`, async () => {
    const receipt = {
      configOptions: [{ id: 'model', category: 'model', currentValue: 'chosen' }],
      _meta: { fixture: true },
    };
    const fixture = await imageFixture(transport, '/fixture', { configResult: receipt });
    try {
      assert.deepEqual(await fixture.client.setSessionConfigOption('owned', 'model', 'chosen'), receipt);
    } finally {
      await fixture.close();
    }
  });
}
