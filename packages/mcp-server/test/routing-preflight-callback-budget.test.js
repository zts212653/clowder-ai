import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { getEncoding } from 'js-tiktoken';
import { normalizeMcpInputSchema } from '../dist/tool-governance-snapshot.js';

const { callbackPost } = await import('../dist/tools/callback-tools.js');

function decision() {
  return {
    v: 1,
    ownerId: 'owner-1',
    observedAt: 10_000,
    resolverState: 'fresh',
    snapshotRef: `sha256:${'a'.repeat(64)}`,
    targets: [
      {
        targetCatId: 'sol',
        disposition: 'allowed',
        alternatives: [],
        reasons: [
          {
            code: 'routing_signal_recovered',
            summary: '已恢复 31 条历史状态记录',
            sourceRefs: [`routing-signal:${'b'.repeat(32)}`],
          },
        ],
        contextualSignals: [
          {
            code: 'capability_strength',
            summary: 'High risk review',
            sourceRefs: ['dossier:sol'],
          },
        ],
      },
    ],
  };
}

describe('F293 routing preflight in callback tool responses', () => {
  it('keeps discovery tool metadata within its previous 226-token resident size', async () => {
    const { callbackTools } = await import('../dist/tools/callback-tools.js');
    const tool = callbackTools.find((tool) => tool.name === 'cat_cafe_get_thread_cats');
    const tokens = getEncoding('o200k_base').encode(
      JSON.stringify({
        description: tool.description,
        inputSchema: normalizeMcpInputSchema(tool.inputSchema),
      }),
    ).length;
    assert.ok(tokens <= 226, `prior resident metadata was 226 tokens; current is ${tokens}`);
  });
  let originalEnv;
  let originalFetch;
  let outbox;
  let response;

  beforeEach(() => {
    originalEnv = { ...process.env };
    originalFetch = globalThis.fetch;
    delete process.env.CAT_CAFE_CREDENTIAL_FILE;
    process.env.CAT_CAFE_API_URL = 'http://127.0.0.1:1';
    process.env.CAT_CAFE_INVOCATION_ID = 'test-invocation';
    process.env.CAT_CAFE_CALLBACK_TOKEN = 'test-token';
    outbox = mkdtempSync(join(tmpdir(), 'f293-receipt-'));
    process.env.CAT_CAFE_CALLBACK_OUTBOX_DIR = outbox;
    globalThis.fetch = async () => ({ ok: true, json: async () => response });
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
    Object.assign(process.env, originalEnv);
    globalThis.fetch = originalFetch;
    rmSync(outbox, { recursive: true, force: true });
  });

  async function send(preflight) {
    response = { status: 'ok', messageId: 'message:sent', routed: ['sol'], routing_preflight: preflight };
    const result = await callbackPost('/api/callbacks/post-message', { content: 'existing work' });
    assert.notEqual(result.isError, true);
    return JSON.parse(result.content[0].text);
  }

  it('returns queue admission as pending execution, never a second execution verdict', async () => {
    const full = decision();
    const admission = {
      v: 1,
      stage: 'queue_admitted',
      executionPreflight: 'pending',
      ownerId: 'owner-1',
      observedAt: 10_000,
      snapshotRef: full.snapshotRef,
      targets: [{ targetCatId: 'sol', availabilityObservation: 'available', reasons: full.targets[0].reasons }],
    };
    response = { messageId: 'message:sent', routed: ['sol'], routing_admission: admission };
    const result = await callbackPost('/api/callbacks/post-message', { content: 'existing work' });
    const body = JSON.parse(result.content[0].text);
    assert.deepEqual(body.routing_admission, {
      stage: 'queue_admitted',
      executionPreflight: 'pending',
      snapshotRef: full.snapshotRef,
      targets: ['sol'],
    });
    assert.equal(body.routing_preflight, undefined);
    admission.targets[0].availabilityObservation = 'unavailable';
    admission.targets[0].reasons = [{ code: 'quota_exhausted', summary: 'No current quota', sourceRefs: ['quota:1'] }];
    const warned = await callbackPost('/api/callbacks/post-message', { content: 'existing work' });
    assert.deepEqual(JSON.parse(warned.content[0].text).routing_admission, admission);
  });

  it('returns a concise healthy receipt with the exact snapshot and latest recovery reference', async () => {
    const full = decision();
    const result = await send(full);
    assert.equal(result.messageId, 'message:sent');
    assert.deepEqual(result.routed, ['sol']);
    assert.deepEqual(result.routing_preflight, {
      snapshotRef: full.snapshotRef,
      targets: [{ targetCatId: 'sol', disposition: 'allowed', reasons: full.targets[0].reasons }],
    });
    assert.ok(full.targets[0].contextualSignals, 'the canonical decision remains complete');
  });

  it('keeps all requested targets in order, including a healthy target without recovery history', async () => {
    const full = decision();
    full.targets.push({ targetCatId: 'argon', disposition: 'allowed', reasons: [], alternatives: [] });
    const result = await send(full);
    assert.deepEqual(
      result.routing_preflight.targets.map((target) => target.targetCatId),
      ['sol', 'argon'],
    );
    assert.deepEqual(result.routing_preflight.targets[1].reasons, []);
  });

  it('preserves complete warnings, rejections, degraded results and unrecognized evidence', async () => {
    for (const disposition of ['warned', 'rejected']) {
      const full = decision();
      full.targets[0].disposition = disposition;
      full.targets[0].reasons = [
        { code: 'routing_signal_scarce', summary: 'Quota is scarce', sourceRefs: ['quota:1'] },
      ];
      full.targets[0].alternatives = [{ catId: 'argon', reasonRefs: ['dossier:argon'] }];
      assert.deepEqual((await send(full)).routing_preflight, full);
    }
    const degraded = decision();
    degraded.resolverState = 'degraded';
    assert.deepEqual((await send(degraded)).routing_preflight, degraded);
    const unrecognized = decision();
    unrecognized.targets[0].reasons[0].code = 'future_warning';
    assert.deepEqual((await send(unrecognized)).routing_preflight, unrecognized);
    const unbound = decision();
    delete unbound.snapshotRef;
    assert.deepEqual((await send(unbound)).routing_preflight, unbound);
  });
});
