import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cueEnvelopeV1Schema } from '@cat-cafe/shared';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { createMemoryCueTools } from '../../../mcp-server/dist/tools/memory-cue-tools.js';
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
  test(`${renderer.name}: copy the displayed handle unchanged through MCP drill and outcome`, async (t) => {
    const db = new Database(':memory:');
    t.after(() => db.close());
    applyMigrations(db);
    const episodes = new MemoryCueEpisodeStore(db);
    const handles = new MemoryCueDrillHandleService(Buffer.alloc(32, 7), episodes);
    const coordinate = {
      cueId: 'cue',
      opportunityId: 'opportunity',
      catalogVersion: 7,
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
      catalogVersion: 7,
      resolverVersion: 1,
      occurredAt: 1_000,
    });
    const issued = handles.issue(coordinate);
    const cue = cueEnvelopeV1Schema.parse({
      v: 1,
      cueId: coordinate.cueId,
      opportunityId: coordinate.opportunityId,
      catalogVersion: 7,
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
    // Copy the complete labeled value, as the Alpha consumer did; never repair/split it here.
    const handleLine = rendered.split('\n').find((line) => /^(?:Handle|Drill): /.test(line));
    assert.ok(handleLine);
    const copied = handleLine.slice(handleLine.indexOf(': ') + 2);
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
    registerCallbackMemoryCueRoutes(app, {
      episodeStore: episodes,
      handles,
      now: () => 2_000,
      sourceReader: {
        async read(input) {
          reads.push(input);
          return { status: 'ok', payload: { body: 'canonical source' } };
        },
      },
    });
    const calls = [];
    const mcp = createMemoryCueTools(async (path, body) => {
      const response = await app.inject({ method: 'POST', url: path, payload: body });
      calls.push({ path, handle: body.handle, statusCode: response.statusCode });
      return { content: [{ type: 'text', text: response.body }] };
    });
    await mcp.handleDrillMemoryCue({ handle: copied, clientRequestId: 'drill' });
    await mcp.handleRecordMemoryCueOutcome({ handle: copied, outcome: 'applied', clientRequestId: 'outcome' });
    assert.deepEqual(
      calls.map((call) => call.statusCode),
      [200, 200],
      JSON.stringify(calls),
    );
    assert.ok(calls.every((call) => call.handle === issued));
    assert.match(rendered, /cat_cafe_drill_memory_cue/);
    assert.match(rendered, /cat_cafe_record_memory_cue_outcome/);
    assert.deepEqual(
      episodes.listByCue(scope.ownerUserId, 'cue').map((event) => event.consumptionOutcome),
      ['presented', 'drilled', 'applied'],
    );
    assert.ok(reads.every((read) => read.expectedRevision === coordinate.revision));
    if (renderer === renderMemoryCuePointer) {
      for (const privateValue of [cue.title, cue.summary, cue.whyNow, coordinate.anchor, coordinate.revision]) {
        assert.ok(!rendered.includes(privateValue));
      }
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
