import assert from 'node:assert/strict';
import { test } from 'node:test';
import { catRegistry } from '@cat-cafe/shared';
import Fastify from 'fastify';
import { setRuntimeOverride } from '../../dist/config/session-strategy-overrides.js';
import { resolveContextLifecycleSupport } from '../../dist/domains/cats/services/agents/context-lifecycle-capability.js';
import {
  applyUsageEvidenceToInvocationSnapshot,
  resolveAuthoritativeContextUsage,
  resolveInvocationCapacitySnapshot,
} from '../../dist/domains/cats/services/agents/invocation/invocation-capacity-snapshot.js';
import { AcpAgentService } from '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { sessionStrategyConfigRoutes } from '../../dist/routes/session-strategy-config.js';
import { imageFixture } from '../helpers/acp-image-fixture.js';

catRegistry.register('acp-context-proof', {
  id: 'acp-context-proof',
  name: 'Context proof',
  displayName: 'Context proof',
  avatar: '/avatars/default.png',
  color: { primary: '#000', secondary: '#fff' },
  mentionPatterns: ['@acp-context-proof'],
  clientId: 'acp',
  defaultModel: 'synthetic',
  roleDescription: 'Isolated context proof',
  mcpSupport: false,
});
await setRuntimeOverride('acp-context-proof', { strategy: 'handoff' }, 'synthetic-test');

async function routeStatus(service) {
  const app = Fastify();
  try {
    await app.register(sessionStrategyConfigRoutes, { resolveContextCapability: () => service.contextCapability() });
    const response = await app.inject({ method: 'GET', url: '/api/config/session-strategy' });
    assert.equal(response.statusCode, 200);
    return response.json().cats.find((c) => c.catId === 'acp-context-proof').executionStatus;
  } finally {
    await app.close();
  }
}

for (const transport of ['stdio', 'http']) {
  for (const providerName of ['acp', 'kimi', 'opencode']) {
    test(`${transport}/${providerName}: standard context evidence still reaches the handoff consumer`, async () => {
      let emitUsage = true;
      const f = await imageFixture(transport, '/fixture', {
        agentPackets: [
          {
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId: 'fresh-1',
              update: { sessionUpdate: 'usage_update', used: 85_000, size: 100_000 },
            },
          },
        ],
        packetTransform: (packets) =>
          emitUsage ? packets : packets.filter((p) => p.params?.update?.sessionUpdate !== 'usage_update'),
      });
      const service = new AcpAgentService({
        catId: 'codex',
        providerName,
        projectRoot: '/fixture',
        mcpSupport: false,
        poolKey: { projectPath: '/fixture', providerProfile: providerName },
        pool: {
          async acquire() {
            return { client: f.client, release() {} };
          },
          rememberSession() {},
        },
      });
      try {
        assert.equal(service.contextCapability().authoritativeUsage, false);
        assert.equal((await routeStatus(service)).status, 'unavailable');
        const initial = resolveInvocationCapacitySnapshot({ catId: 'codex', service });
        const messages = [];
        for await (const message of service.invoke('Synthetic context test')) messages.push(message);
        const usage = messages.find((m) => m.metadata?.usage?.contextUsedTokens === 85_000)?.metadata.usage;
        assert.ok(usage);
        const snapshot = applyUsageEvidenceToInvocationSnapshot({
          snapshot: initial,
          catId: 'codex',
          capability: service.contextCapability(),
          reportedWindowSize: usage.contextWindowSize,
        });
        assert.equal(snapshot.capacity.source, 'reported');
        assert.equal(snapshot.capacity.actionable, true);
        const used = resolveAuthoritativeContextUsage(usage, snapshot.capability);
        assert.deepEqual(used, { usedTokens: 85_000, usedFrom: 'context' });
        assert.ok(used.usedTokens / snapshot.capacity.inputCeilingTokens >= 0.85);
        assert.equal(resolveContextLifecycleSupport(service.contextCapability(), 'handoff').supported, true);
        assert.equal((await routeStatus(service)).status, 'active');
        assert.equal(service.contextCapability().nativeCompressionControl, false);
        assert.equal(
          messages.find((m) => m.metadata?.diagnostics?.acpUsage)?.metadata.diagnostics.acpUsage.verification,
          'bridge_reported',
        );
        emitUsage = false;
        for await (const _message of service.invoke('Next synthetic context test')) {
          /* drain */
        }
        assert.equal(service.contextCapability().authoritativeUsage, false, 'next invocation needs its own evidence');
        assert.equal(service.contextCapability().usageTelemetry, 'conditional');
        assert.equal((await routeStatus(service)).status, 'unavailable');
      } finally {
        await f.close();
      }
    });
  }
  for (const update of [{ used: -1, size: 100 }, { used: 1 }, { size: 100 }, { used: 1, size: 0 }]) {
    test(`${transport}: incomplete or invalid context stays conditional ${JSON.stringify(update)}`, async () => {
      const f = await imageFixture(transport, '/fixture', {
        agentPackets: [
          {
            jsonrpc: '2.0',
            method: 'session/update',
            params: { sessionId: 'fresh-1', update: { sessionUpdate: 'usage_update', ...update } },
          },
        ],
      });
      const service = new AcpAgentService({
        catId: 'codex',
        projectRoot: '/fixture',
        mcpSupport: false,
        poolKey: { projectPath: '/fixture', providerProfile: 'fixture' },
        pool: {
          async acquire() {
            return { client: f.client, release() {} };
          },
          rememberSession() {},
        },
      });
      try {
        for await (const _message of service.invoke('Invalid synthetic context test')) {
          /* drain */
        }
        assert.equal(service.contextCapability().authoritativeUsage, false);
        assert.equal(service.contextCapability().usageTelemetry, 'conditional');
      } finally {
        await f.close();
      }
    });
  }
}
