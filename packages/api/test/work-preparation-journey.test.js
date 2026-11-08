import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createRedisClient } from '@cat-cafe/shared/utils';
import Fastify from 'fastify';
import {
  handleDrillMemoryCue,
  handleGetMessage,
  handlePrepareMemoryContext,
  handleRecordMemoryCueOutcome,
} from '../../mcp-server/dist/tools/callback-tools.js';
import { InvocationRegistry } from '../dist/domains/cats/services/agents/invocation/InvocationRegistry.js';
import { contextEpochScopeKey } from '../dist/domains/cats/services/session/context/ContextEpochOwner.js';
import { RedisContextEpochStore } from '../dist/domains/cats/services/stores/redis/RedisContextEpochStore.js';
import { RedisMessageStore } from '../dist/domains/cats/services/stores/redis/RedisMessageStore.js';
import { RedisThreadStore } from '../dist/domains/cats/services/stores/redis/RedisThreadStore.js';
import { MemoryCueDrillHandleService } from '../dist/domains/memory/cue/MemoryCueDrillHandleService.js';
import { MemoryCueEpisodeStore } from '../dist/domains/memory/cue/MemoryCueEpisodeStore.js';
import { OwnerPreparationSources } from '../dist/domains/memory/cue/preparation/OwnerPreparationSources.js';
import { WorkPreparationAuthority } from '../dist/domains/memory/cue/preparation/WorkPreparationAuthority.js';
import { WorkPreparationOpportunityStore } from '../dist/domains/memory/cue/preparation/WorkPreparationOpportunityStore.js';
import { WorkPreparationService } from '../dist/domains/memory/cue/preparation/WorkPreparationService.js';
import { CanonicalTasteMemoryCueSource } from '../dist/domains/memory/cue/sources/TasteMemoryCueSource.js';
import { IndexBuilder } from '../dist/domains/memory/IndexBuilder.js';
import { MessageSearchService } from '../dist/domains/memory/MessageSearchService.js';
import { MatterMemoryService } from '../dist/domains/memory/matters/MatterMemoryService.js';
import { SqliteEvidenceStore } from '../dist/domains/memory/SqliteEvidenceStore.js';
import { FileTasteRepository } from '../dist/domains/taste/services/TasteRepository.js';
import { callbacksRoutes } from '../dist/routes/callbacks.js';

const isolated = process.env.CAT_CAFE_REDIS_TEST_ISOLATED === '1';
const parseTool = (result) => {
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  return JSON.parse(result.content[0].text);
};

test(
  'real index → authenticated MCP preparation → original reads → next video/HTML action',
  {
    skip: isolated ? false : 'Run through the canonical isolated Redis runner',
  },
  async () => {
    const endpoint = new URL(process.env.REDIS_URL);
    assert.equal(endpoint.hostname, '127.0.0.1');
    assert.ok(![6397, 6398, 6399].includes(Number(endpoint.port)));
    const redis = createRedisClient({ url: endpoint.href });
    const messages = new RedisMessageStore(redis, { ttlSeconds: 0 });
    const threads = new RedisThreadStore(redis, { ttlSeconds: 0 });
    const epochs = new RedisContextEpochStore(redis);
    const directory = mkdtempSync(join(tmpdir(), 'f332-preparation-'));
    const evidence = new SqliteEvidenceStore(join(directory, 'evidence.sqlite'));
    const registry = new InvocationRegistry();
    const app = Fastify();
    const previousEnv = { ...process.env };
    const steps = [];
    try {
      await evidence.initialize();
      const thread = await threads.create('owner', 'Paper then video and HTML', directory);
      const history = await threads.create('owner', 'Original production experience', directory);
      const hidden = await threads.create('other-owner', 'Private unshared experience', directory);
      const append = (target, content) =>
        messages.append({
          userId: target.createdBy,
          threadId: target.id,
          from: { kind: 'user', userId: target.createdBy },
          mentions: [],
          content,
          timestamp: Date.now(),
        });
      const paper = await append(
        thread,
        'Paper reading: section 4 separates the toy example from production evidence.',
      );
      const videoRule = await append(
        history,
        'video videoprepexperience: When turning this paper into a video, preserve the section 4 toy-example boundary in the storyboard.',
      );
      const htmlRule = await append(
        history,
        'For this shared meeting memo HTML only, use SVG labels and retain the named audience. This is not a rule for all UI.',
      );
      await append(hidden, 'video videoprepexperience private secret must never leak.');
      const trigger = await append(thread, 'Read the paper, then prepare a video and this shared memo HTML.');
      const actor = { userId: 'owner', viewer: { type: 'cat', catId: 'codex61-sol' } };
      const matters = new MatterMemoryService({
        db: evidence.getDb(),
        runWrite: (op) => evidence.runExclusive(op),
        messageStore: messages,
        threadStore: threads,
      });
      const matter = await matters.write(actor, {
        operation: 'create',
        requestId: 'html-fixture',
        title: 'html htmlmemoscope',
        description: 'Only the named shared meeting memo; retain the audience and SVG condition.',
        sources: [
          {
            threadId: history.id,
            messageId: htmlRule.id,
            segment: 'body',
            start: 0,
            end: htmlRule.content.length,
            quote: htmlRule.content,
          },
        ],
      });
      const allThreads = [thread, history, hidden];
      const builder = new IndexBuilder(
        evidence,
        directory,
        undefined,
        undefined,
        () => allThreads,
        (id, limit) => messages.getByThread(id, limit, allThreads.find((row) => row.id === id).createdBy),
      );
      for (const target of allThreads) builder.markThreadDirty(target.id);
      await builder.flushDirtyThreads();
      const search = new MessageSearchService({
        evidenceStore: evidence,
        messageStore: messages,
        threadStore: threads,
      });
      const episodes = new MemoryCueEpisodeStore(evidence.getDb());
      const opportunities = new WorkPreparationOpportunityStore(evidence.getDb());
      const handles = new MemoryCueDrillHandleService(Buffer.alloc(32, 7), {
        findPresentedCoordinate: (...args) => episodes.findPresentedCoordinate(...args),
        findPreparedCoordinate: (...args) => opportunities.findPreparedCoordinate(...args),
      });
      const service = new WorkPreparationService({
        episodes,
        store: opportunities,
        handles,
        authority: new WorkPreparationAuthority({ threads, messages, epochs }),
        sources: new OwnerPreparationSources({
          messages: search,
          matters,
          taste: new CanonicalTasteMemoryCueSource(new FileTasteRepository(directory), 'owner'),
        }),
      });
      await app.register(callbacksRoutes, {
        registry,
        messageStore: messages,
        threadStore: threads,
        evidenceStore: evidence,
        socketManager: { broadcastAgentMessage() {} },
        memoryCueDeps: {
          handles,
          episodeStore: episodes,
          preparation: service,
          sourceReader: { read: (request) => service.read(request) },
          now: Date.now,
        },
      });
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const auth = await registry.create(
        'owner',
        'codex61-sol',
        thread.id,
        undefined,
        undefined,
        undefined,
        trigger.id,
        'strict',
      );
      const key = contextEpochScopeKey({ userId: 'owner', catId: 'codex61-sol', threadId: thread.id });
      assert.equal(
        await epochs.compareAndPut(
          {
            scopeKey: key,
            contextEpoch: 1,
            contextMode: 'hot',
            version: 1,
            lastTransitionRef: 'fixture:launch',
            updatedAt: Date.now(),
          },
          0,
        ),
        true,
      );
      delete process.env.CAT_CAFE_CREDENTIAL_FILE;
      delete process.env.CAT_CAFE_NATIVE_TURN_CREDENTIAL_FILE;
      Object.assign(process.env, {
        CAT_CAFE_API_URL: address,
        CAT_CAFE_INVOCATION_ID: auth.invocationId,
        CAT_CAFE_CALLBACK_TOKEN: auth.callbackToken,
        CAT_CAFE_USER_ID: 'forged-environment-owner',
      });
      const paperRead = parseTool(await handleGetMessage({ messageId: paper.id, mode: 'full' }));
      assert.equal(paperRead.message.content, paper.content);
      steps.push({ event: 'paper_read', at: Date.now(), source: paper.id });
      assert.deepEqual(
        parseTool(await handlePrepareMemoryContext({ activity: 'html', query: 'unrelatedzxq' })).pointers,
        [],
      );
      const video = parseTool(await handlePrepareMemoryContext({ activity: 'video', query: 'videoprepexperience' }));
      assert.equal(video.delivery, 'unknown');
      assert.equal(video.pointers.length, 1, JSON.stringify(video));
      assert.equal(video.pointers[0].source.anchor.includes('private'), false);
      assert.equal(episodes.listByInvocation('owner', thread.id, auth.invocationId).length, 0);
      steps.push({ event: 'video_preparation_received', at: video.observedAt, opportunityId: video.opportunityId });
      const videoSource = parseTool(
        await handleDrillMemoryCue({ handle: video.pointers[0].read.handle, clientRequestId: 'video-read' }),
      );
      assert.equal(videoSource.payload.message.content, videoRule.content);
      steps.push({ event: 'video_source_read', at: Date.now(), sourceRevision: video.pointers[0].source.revision });
      writeFileSync(
        join(directory, 'video-storyboard.json'),
        JSON.stringify({
          paper: paper.id,
          scene: 'section 4 toy example',
          originalConstraint: videoSource.payload.message.content,
        }),
      );
      steps.push({ event: 'video_storyboard_started', at: Date.now() });
      assert.match(readFileSync(join(directory, 'video-storyboard.json'), 'utf8'), /toy-example boundary/);
      const sourceSignals = [];
      const ownerProject = matters.project.bind(matters);
      matters.project = async (actor, ...args) => {
        sourceSignals.push(actor.signal);
        return ownerProject(actor, ...args);
      };
      const html = parseTool(await handlePrepareMemoryContext({ activity: 'html', query: 'htmlmemoscope' }));
      assert.ok(sourceSignals.length > 1);
      assert.ok(
        sourceSignals.every((signal) => signal === sourceSignals[0]),
        'native and final Matter projections share the discovery cancellation signal',
      );
      matters.project = ownerProject;

      assert.equal(html.pointers.length, 1, JSON.stringify(html));
      assert.equal(html.pointers[0].source.anchor, `matter:${matter.matter.matterId}`);
      assert.equal(html.pointers[0].application, 'not_supported');
      steps.push({ event: 'html_preparation_received', at: html.observedAt });
      const htmlSource = parseTool(
        await handleDrillMemoryCue({ handle: html.pointers[0].read.handle, clientRequestId: 'html-read' }),
      );
      assert.equal(htmlSource.payload.entries[0].quote, htmlRule.content);
      steps.push({ event: 'html_rule_read', at: Date.now(), sourceRevision: html.pointers[0].source.revision });
      writeFileSync(
        join(directory, 'memo.html'),
        '<!doctype html><title>Named shared meeting memo</title><svg role="img" aria-label="Named audience"><text y="20">Shared memo</text></svg>',
      );
      steps.push({ event: 'html_started_with_svg', at: Date.now() });
      assert.match(readFileSync(join(directory, 'memo.html'), 'utf8'), /<svg/);
      for (const outcome of ['applied', 'dismissed'])
        assert.equal(
          (
            await handleRecordMemoryCueOutcome({
              handle: html.pointers[0].read.handle,
              outcome,
              clientRequestId: outcome,
            })
          ).isError,
          true,
        );
      const repeated = parseTool(await handlePrepareMemoryContext({ activity: 'html', query: 'htmlmemoscope' }));
      assert.deepEqual(repeated.pointers, []);
      assert.deepEqual(
        parseTool(await handlePrepareMemoryContext({ activity: 'html', query: 'unrelatedzxq' })).pointers,
        [],
      );
      const events = episodes.listByInvocation('owner', thread.id, auth.invocationId);
      assert.deepEqual(
        events.map((row) => row.consumptionOutcome),
        ['presented', 'drilled', 'presented', 'drilled'],
      );
      assert.ok(events.every((row) => row.readOrigin === 'explicit_read'));
      assert.ok(steps.every((step, index) => index === 0 || step.at >= steps[index - 1].at));
      assert.equal(events[0].occurredAt >= video.observedAt, true);
      console.info(
        JSON.stringify({
          kind: 'f332-w3-development-journey',
          isolatedRedis: `${endpoint.hostname}:${endpoint.port}${endpoint.pathname}`,
          discoveryVersion: video.discoveryVersion,
          delivery: 'unknown_until_explicit_read',
          steps,
          receipts: events.map(({ resolverFamily, consumptionOutcome, sourceRevision, occurredAt, readOrigin }) => ({
            resolverFamily,
            consumptionOutcome,
            sourceRevision,
            occurredAt,
            readOrigin,
          })),
        }),
      );
    } finally {
      await app.close();
      await evidence.close();
      await redis.quit();
      rmSync(directory, { recursive: true, force: true });
      for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
      Object.assign(process.env, previousEnv);
    }
  },
);
