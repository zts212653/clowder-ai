import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveInvocationCapacitySnapshot } from '../dist/domains/cats/services/agents/invocation/invocation-capacity-snapshot.js';
import { invokeSingleCat } from '../dist/domains/cats/services/agents/invocation/invoke-single-cat.js';
import { AcpAgentService } from '../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js';
import { AcpClient } from '../dist/domains/cats/services/agents/providers/acp/AcpClient.js';
import { ContextEpochOwner } from '../dist/domains/cats/services/session/context/ContextEpochOwner.js';
import { InMemoryContextEpochStore } from '../dist/domains/cats/services/stores/ports/ContextEpochStore.js';

const relay = fileURLToPath(new URL('./helpers/pi-bridge-test-relay.mjs', import.meta.url));
for (const [label, diagnostic, prompt, primaryCause, recovery] of [
  ['missing session', 'Previous unrelated cache lookup: Session not found', 'empty-diagnostic'],
  ['context window', 'Previous unrelated response: context window exceeded', 'empty-diagnostic'],
  ['network', 'Previous unrelated request: ECONNRESET', 'empty-diagnostic'],
  ['process exit', 'Previous unrelated cache lookup: Session not found', 'exit'],
  ['genuine missing session', 'Previous benign status', 'rejected', 'Session not found', 'fresh'],
  ['genuine context window', 'Previous benign status', 'rejected', 'context window exceeded', 'fresh'],
  ['genuine network', 'Previous benign status', 'rejected', 'ECONNRESET', 'same'],
]) {
  test(
    recovery
      ? `Pi ${label} retains the existing recovery`
      : `recent Pi ${label} diagnostics never delete a session or replay a failed turn`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'pi-invocation-context-'));
      writeFileSync(
        join(root, 'diagnostic-text'),
        `${diagnostic}; api_key=secret-context-token; /srv/private/project.log`,
      );
      if (primaryCause) writeFileSync(join(root, 'primary-error-text'), primaryCause);
      const client = new AcpClient({ command: process.execPath, args: [relay, root], cwd: root });
      try {
        await client.initialize();
        const sessionId = (await client.newSession(root, [])).sessionId;
        const host = new AcpAgentService({
          catId: 'opus',
          projectRoot: root,
          mcpSupport: false,
          providerName: 'Pi',
          poolKey: {},
          pool: {
            async acquire() {
              return { client, release() {} };
            },
          },
        });
        if (prompt === 'exit') {
          for await (const _ of host.invoke('empty-diagnostic', { workingDirectory: root, sessionId })) {
            /* seed recent context */
          }
        }
        const calls = [],
          deletes = [];
        const service = {
          l0CompilerFn: async () => '# test L0',
          contextCapability: () => ({
            provider: 'test',
            carrier: 'test_stream',
            reportsRuntimeWindow: true,
            authoritativeUsage: true,
            nativeWindowControl: false,
            nativeCompressionControl: false,
            observesCompression: false,
            reason: 'fixture',
          }),
          async *invoke(_input, options) {
            calls.push(options.sessionId ?? null);
            if (calls.length === 1) {
              yield* host.invoke(prompt, { workingDirectory: root, sessionId: options.sessionId });
              return;
            }
            // A safe sentinel exposes an unintended replay without a second provider call.
            yield { type: 'text', catId: 'opus', content: 'SAFE RETRY SENTINEL', timestamp: Date.now() };
            yield { type: 'done', catId: 'opus', timestamp: Date.now() };
          },
        };
        let sequence = 0;
        const deps = {
          registry: {
            create: () => ({ invocationId: `context-fixture-${++sequence}`, callbackToken: `fixture-${sequence}` }),
            verify: async () => ({ ok: false, reason: 'unknown_invocation' }),
          },
          sessionManager: {
            get: async () => sessionId,
            getOrCreate: async () => ({}),
            store: async () => {},
            delete: async () => {
              deletes.push('deleted');
            },
            resolveWorkingDirectory: () => root,
          },
          threadStore: null,
          apiUrl: 'http://127.0.0.1:3102',
          contextEpochOwner: new ContextEpochOwner(new InMemoryContextEpochStore()),
        };
        const params = {
          catId: 'opus',
          service,
          prompt: 'fixture input',
          userId: 'fixture-user',
          threadId: 'pi-context-fixture',
          isLastCat: true,
        };
        const capacitySnapshot = await resolveInvocationCapacitySnapshot({
          catId: params.catId,
          threadId: params.threadId,
          service,
          sessionChainStore: undefined,
        });
        const messages = [];
        for await (const message of invokeSingleCat(deps, { ...params, capacitySnapshot })) messages.push(message);
        if (recovery) {
          assert.deepEqual(calls, [sessionId, recovery === 'fresh' ? null : sessionId]);
          assert.deepEqual(deletes, recovery === 'fresh' ? ['deleted'] : []);
          assert.ok(messages.some((message) => message.content === 'SAFE RETRY SENTINEL'));
          return;
        }
        assert.deepEqual(calls, [sessionId], 'diagnostic text must never cause another execution');
        assert.deepEqual(deletes, [], 'diagnostic text must never discard the native session binding');
        const failure = messages.find((message) => message.type === 'error');
        assert.equal(failure?.errorCode, 'prompt_failure');
        assert.ok(!failure.error.includes(diagnostic));
        assert.equal(failure.metadata.cliDiagnostics.reasonCode, undefined);
        assert.ok(failure.metadata.cliDiagnostics.safeExcerpt.includes(diagnostic));
        assert.doesNotMatch(failure.metadata.cliDiagnostics.safeExcerpt, /secret-context-token|\/srv\/private/);
        assert.equal(
          messages.some((message) => message.content === 'SAFE RETRY SENTINEL'),
          false,
        );
      } finally {
        await client.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
}
