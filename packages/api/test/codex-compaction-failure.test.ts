import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CodexAppServerClient } from '../src/domains/cats/services/agents/providers/CodexAppServerClient.js';
import {
  CODEX_ACTIVE_WORK_CONTEXT_DECISION,
  CODEX_COMPACTION_CONTINUATION_TRIGGER,
  codexActiveWorkContext,
} from '../src/domains/cats/services/agents/providers/codex-active-work-context.js';
import type { PreparedProviderRequestV1 } from '../src/domains/cats/services/types.js';
import { CodexStartupWire } from './helpers/codex-startup-wire.js';

class ActiveCompactionWire extends CodexStartupWire {
  terminations = 0;
  releases = 0;
  constructor(readonly failure: 'record' | 'steer' | 'mismatch') {
    super();
  }
  override async write(message: Record<string, unknown>) {
    if (message.method === 'turn/steer') {
      this.writes.push(message);
      this.push(
        this.failure === 'steer'
          ? { id: message.id, error: { code: -32000, message: 'continuation rejected' } }
          : { id: message.id, result: { turnId: 'another-turn' } },
      );
      return;
    }
    if (message.method !== 'turn/start') return super.write(message);
    this.writes.push(message);
    this.push({ id: message.id, result: { turn: { id: 'same-turn', status: 'inProgress' } } });
    this.push({
      method: 'item/completed',
      params: {
        threadId: 'same-native-thread',
        turnId: 'same-turn',
        item: { id: 'native-window-change', type: 'contextCompaction' },
      },
    });
    // No authoritative terminal: this turn must be terminated, never released.
  }
  async terminate() {
    this.terminations++;
    await super.close();
  }
  override async close() {
    this.releases++;
    await super.close();
  }
}

function prepare(): PreparedProviderRequestV1 {
  const context = codexActiveWorkContext({
    threadId: 'cafe-thread',
    invocationId: 'invocation',
    promptMessageIds: ['source'],
  });
  assert.ok(context);
  return {
    v: 1,
    boundaryReason: 'provider_continuation',
    message: { body: CODEX_COMPACTION_CONTINUATION_TRIGGER, injectionDecision: CODEX_ACTIVE_WORK_CONTEXT_DECISION },
    nativeInstructions: [context],
    runtime: { provider: 'openai', carrier: 'app_server' },
    tools: { finalSurface: 'unknown' },
    providerNativeVisibility: 'unknown',
  };
}

for (const failure of ['record', 'steer', 'mismatch'] as const) {
  test(`compaction ${failure} failure evicts the still-active native turn instead of returning it warm`, async () => {
    const wire = new ActiveCompactionWire(failure);
    const client = new CodexAppServerClient({ wire });
    let recorded = 0;
    await assert.rejects(
      async () => {
        for await (const _ of client.run({
          thread: { kind: 'start' },
          prompt: { kind: 'frozen', prompt: 'original task' },
          prepareRequest: (body) => ({ ...prepare(), message: { body } }),
          prepareCompactionRequest: prepare,
          beforeProviderLaunch: async () => {
            if (++recorded === 2 && failure === 'record') throw new Error('recording failed');
            return { requestGenerationId: 'generation', generationOrdinal: recorded, sessionId: 'session' };
          },
        })) {
          /* Consume the real client lifecycle, including finally. */
        }
      },
      failure === 'record' ? /recording failed/ : failure === 'steer' ? /continuation rejected/ : /turn_mismatch/,
    );
    assert.equal(wire.terminations, 1, 'a still-active provider must be evicted');
    assert.equal(wire.releases, 0, 'ordinary close would return a pooled host warm');
    assert.equal(wire.writes.filter((message) => message.method === 'turn/start').length, 1);
    assert.equal(wire.writes.filter((message) => message.method === 'turn/steer').length, failure === 'record' ? 0 : 1);
  });
}
