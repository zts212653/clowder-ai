import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cueEnvelopeV1Schema, RECALL_OPPORTUNITY_CATALOG_VERSION } from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { CANONICAL_TOOL_REGISTRY } from '../../../mcp-server/dist/canonical-server-tools.js';
import { withInvocationCredentials } from '../../../mcp-server/dist/tools/invocation-auth.js';
import {
  formatMemoryCues,
  renderMemoryCue,
  renderMemoryCuePointer,
  renderThreadOpeningClue,
} from '../../dist/domains/memory/cue/format-memory-cues.js';
import { MemoryCueDrillHandleService } from '../../dist/domains/memory/cue/MemoryCueDrillHandleService.js';
import { MemoryCueEpisodeStore } from '../../dist/domains/memory/cue/MemoryCueEpisodeStore.js';
import { applyMigrations } from '../../dist/domains/memory/schema.js';
import { registerCallbackMemoryCueRoutes } from '../../dist/routes/callback-memory-cue-routes.js';
import { estimateTokens } from '../../dist/utils/token-counter.js';

const scope = { ownerUserId: 'owner', threadId: 'thread', invocationId: 'invocation' };

for (const [renderer, family] of [
  [renderMemoryCue, 'profile'],
  [renderMemoryCuePointer, 'profile'],
  [renderThreadOpeningClue, 'thread_overview'],
]) {
  test(`${renderer.name}: copy the displayed ReadRef unchanged through MCP read and outcome`, async (t) => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    applyMigrations(db);
    const episodes = new MemoryCueEpisodeStore(db);
    const handles = new MemoryCueDrillHandleService(Buffer.alloc(32, 7), episodes);
    const coordinate = {
      cueId: 'cue',
      opportunityId: 'opportunity',
      catalogVersion: RECALL_OPPORTUNITY_CATALOG_VERSION,
      resolverFamily: family,
      resolverVersion: 1,
      family,
      anchor: 'private-source',
      revision: 'current-revision',
      scope,
      consumerCatId: 'codex61-sol',
      expiresAt: 10_000,
    };
    episodes.append({
      eventId: 'presented',
      idempotencyKey: 'presented',
      cueId: coordinate.cueId,
      opportunityId: coordinate.opportunityId,
      scope,
      consumerCatId: coordinate.consumerCatId,
      resolverFamily: family,
      sourceAnchor: coordinate.anchor,
      sourceRevision: coordinate.revision,
      axis: 'consumption',
      consumptionOutcome: 'presented',
      catalogVersion: RECALL_OPPORTUNITY_CATALOG_VERSION,
      resolverVersion: 1,
      occurredAt: 1_000,
    });
    const issued = handles.issue(coordinate);
    const cue = cueEnvelopeV1Schema.parse({
      v: 1,
      cueId: coordinate.cueId,
      opportunityId: coordinate.opportunityId,
      catalogVersion: RECALL_OPPORTUNITY_CATALOG_VERSION,
      resolverFamily: family,
      resolverVersion: 1,
      whyNow: 'private reason',
      title: 'private title',
      summary: 'private summary',
      source: { anchor: coordinate.anchor, revision: coordinate.revision, visibility: 'owner_private' },
      drill: { family, handle: issued },
      scope,
      expiresAt: coordinate.expiresAt,
      invalidators: ['source_corrected', 'source_forgotten', 'scope_revoked', 'superseded', 'expired'],
    });
    const rendered = renderer(cue);
    // Copy the whole displayed coordinate without rebuilding it or looking up a version.
    const refLine = rendered.split('\n').find((line) => line.startsWith('ReadRef: '));
    assert.ok(refLine);
    const copied = JSON.parse(refLine.slice('ReadRef: '.length));
    assert.equal(copied.kind, 'cue');
    assert.equal(copied.handle, issued);
    if (renderer === renderMemoryCuePointer) {
      for (const privateValue of [cue.title, cue.summary, cue.whyNow, coordinate.anchor, coordinate.revision]) {
        assert.ok(!rendered.includes(privateValue));
      }
      assert.equal(copied.expectedRevision, undefined);
    } else {
      assert.equal(copied.expectedRevision, coordinate.revision);
    }
    const app = Fastify();
    t.after(() => app.close());
    app.decorateRequest('callbackAuth', undefined);
    app.addHook('preHandler', async (request) => {
      request.callbackAuth = {
        ...scope,
        userId: scope.ownerUserId,
        catId: coordinate.consumerCatId,
        callbackToken: 'isolated-test',
        clientMessageIds: new Set(),
        createdAt: 0,
        expiresAt: 10_000,
      };
    });
    const reads = [];
    let currentRevision = coordinate.revision;
    registerCallbackMemoryCueRoutes(app, {
      episodeStore: episodes,
      handles,
      now: () => 2_000,
      sourceReader: {
        async read(input) {
          reads.push(input);
          if (input.expectedRevision !== currentRevision)
            return { status: 'not_available', invalidationReason: 'source_corrected' };
          return { status: 'ok', payload: { body: 'canonical source' } };
        },
      },
    });
    const calls = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, init) => {
      const path = new URL(url).pathname;
      const body = JSON.parse(init.body);
      const response = await app.inject({ method: 'POST', url: path, payload: body });
      calls.push({ path, handle: body.handle, statusCode: response.statusCode });
      return new Response(response.body, { status: response.statusCode, headers: response.headers });
    };
    t.after(() => {
      globalThis.fetch = originalFetch;
    });
    const credentials = {
      ...scope,
      userId: scope.ownerUserId,
      catId: coordinate.consumerCatId,
      callbackToken: 'isolated-test',
      apiUrl: 'http://memory-fixture',
    };
    const readTool = CANONICAL_TOOL_REGISTRY.find((tool) => tool.name === 'cat_cafe_read_memory');
    const outcomeTool = CANONICAL_TOOL_REGISTRY.find((tool) => tool.name === 'cat_cafe_record_memory_cue_outcome');
    assert.ok(readTool);
    assert.ok(outcomeTool);
    const read = () => withInvocationCredentials(credentials, () => readTool.handler({ ref: copied }));
    const result = await read();
    const envelope = JSON.parse(result.content[0].text);
    assert.equal(envelope.status, 'ok');
    assert.equal(envelope.data.payload.body, 'canonical source');
    assert.equal(envelope.version, coordinate.revision);
    await withInvocationCredentials(credentials, () =>
      outcomeTool.handler({ handle: copied.handle, outcome: 'applied', clientRequestId: 'outcome' }),
    );
    assert.deepEqual(
      calls.map((call) => call.statusCode),
      [200, 200],
      JSON.stringify(calls),
    );
    assert.ok(calls.every((call) => call.handle === issued));
    assert.match(rendered, /cat_cafe_read_memory/);
    assert.match(rendered, /cat_cafe_record_memory_cue_outcome/);
    assert.deepEqual(
      episodes.listByCue(scope.ownerUserId, 'cue').map((event) => event.consumptionOutcome),
      ['presented', 'drilled', 'applied'],
    );
    assert.ok(reads.every((read) => read.expectedRevision === coordinate.revision));
    if (renderer === renderMemoryCuePointer) {
      currentRevision = 'corrected-revision';
      const stale = JSON.parse((await read()).content[0].text);
      assert.equal(stale.status, 'not_available');
      assert.equal(stale.data, undefined);
      assert.equal(reads.at(-1).expectedRevision, coordinate.revision, 'the original receipt still pins the version');
      assert.equal(
        episodes.listByCue(scope.ownerUserId, 'cue').filter((event) => event.consumptionOutcome === 'drilled').length,
        1,
      );
    }
    // The presentation fix must not weaken the strict authenticated-handle parser.
    assert.deepEqual(handles.verify(`${family} ${issued}`, scope, 2_000, coordinate.consumerCatId), {
      ok: false,
      reason: 'invalid_handle',
    });
    assert.equal(handles.verify(issued, { ...scope, threadId: 'other' }, 2_000, coordinate.consumerCatId).ok, false);
    assert.equal(handles.verify(issued, scope, 2_000, 'other-cat').ok, false);

    for (const pointerOnly of [false, true]) {
      const enough = formatMemoryCues([cue], { maxTokens: 900, pointerOnly });
      assert.equal(enough.cues.length, 1);
      assert.equal(enough.estimatedTokens, estimateTokens(enough.text));
      const trimmed = formatMemoryCues([cue], { maxTokens: enough.estimatedTokens - 1, pointerOnly });
      assert.equal(trimmed.text, '');
      assert.equal(trimmed.cues.length, 0, 'the whole handle/instruction must be omitted, never truncated');
    }
  });
}
