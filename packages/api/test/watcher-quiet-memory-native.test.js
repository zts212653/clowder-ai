import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { ApprovalIngress } from '../dist/domains/approval-hub/ApprovalIngress.js';
import { FileProfileRepository } from '../dist/domains/cats/services/profile/ProfileRepository.js';
import { InMemoryProfileUpdateProposalStore } from '../dist/domains/cats/services/stores/ports/ProfileUpdateProposalStore.js';
import { MatterMemoryService } from '../dist/domains/memory/matters/MatterMemoryService.js';
import { SqliteEvidenceStore } from '../dist/domains/memory/SqliteEvidenceStore.js';
import { InMemoryTasteProposalStore } from '../dist/domains/taste/stores/InMemoryTasteProposalStore.js';
import { registerCallbackAuthHook } from '../dist/routes/callback-auth-prehandler.js';
import { registerCallbackProposeProfileUpdateRoutes } from '../dist/routes/callback-propose-profile-update-routes.js';
import { callbackProposeTasteRoutes } from '../dist/routes/callback-propose-taste-routes.js';
import { registerCallbackRememberRoutes } from '../dist/routes/callback-remember-routes.js';
import { registerCallbackMatterMemoryRoutes } from '../dist/routes/memory-matter-routes.js';
import { nativeWatcherAvailable, watcherNativeFixture } from './helpers/watcher-native-fixture.js';
import { watcherWorld } from './helpers/watcher-world.js';

test(
  'a quiet native watcher uses code mode to write/read matters and submit profile/taste approval proposals',
  { timeout: 45000, skip: !nativeWatcherAvailable },
  async () => {
    const w = await watcherWorld();
    let matter, evidence, repository;
    const profile = new InMemoryProfileUpdateProposalStore();
    const tastes = new InMemoryTasteProposalStore();
    const old = process.env.F335_WATCHER_REVIEW_RED_MODULE
      ? (await import(process.env.F335_WATCHER_REVIEW_RED_MODULE)).runWatcherInvocation
      : undefined;
    const f = await watcherNativeFixture(w, {
      model: 'gpt-6.1-sol',
      ...(old ? { invoke: old } : {}),
      async configure({ app, root }) {
        evidence = new SqliteEvidenceStore(join(root, 'original-memory.sqlite'));
        await evidence.initialize();
        matter = new MatterMemoryService({
          db: evidence.getDb(),
          messageStore: w.messages,
          threadStore: w.threads,
          runWrite: (operation) => evidence.runExclusive(operation),
        });
        repository = new FileProfileRepository({
          dataDir: join(root, 'profile-test'),
          relationshipKeyForCat: () => 'maine-coon',
        });
        const sockets = { emitToUser() {}, broadcastToRoom() {} };
        await app.register(async (scope) => {
          registerCallbackAuthHook(scope, w.registry);
          registerCallbackMatterMemoryRoutes(scope, matter);
          registerCallbackRememberRoutes(scope, {
            registry: w.registry,
            messageStore: w.messages,
            socketManager: sockets,
          });
          registerCallbackProposeProfileUpdateRoutes(scope, {
            registry: w.registry,
            proposalStore: profile,
            messageStore: w.messages,
            socketManager: sockets,
            repository,
          });
        });
        await app.register(callbackProposeTasteRoutes, {
          registry: w.registry,
          tasteProposalStore: tastes,
          socketManager: sockets,
          messageStore: w.messages,
          approvalIngress: new ApprovalIngress({ messageStore: w.messages, socketManager: sockets }),
        });
        return () => evidence.close();
      },
    });
    try {
      const original = await w.messages.append({
        userId: 'watcher-owner',
        threadId: w.thread.id,
        from: { kind: 'user', userId: 'watcher-owner' },
        content: '这是一条测试人物线索；界面用词要像家人。',
        timestamp: Date.now(),
        mentions: [],
      });
      const [source] = await w.work('RAW_INCREMENT_12', { currentUserMessageId: original.id });
      f.state.quiet = true;
      f.state.codeMode = true;
      f.state.toolPlan = [
        {
          name: 'cat_cafe_remember',
          args: {
            clientRequestId: 'quiet-memory-batch',
            items: [
              {
                itemId: 'matter',
                target: 'matter',
                payload: {
                  operation: 'create',
                  requestId: 'quiet-memory-matter',
                  title: '守望测试原话',
                  sources: [
                    {
                      threadId: original.threadId,
                      messageId: original.id,
                      segment: 'body',
                      start: 0,
                      end: original.content.length,
                      quote: original.content,
                    },
                  ],
                },
              },
              {
                itemId: 'profile',
                target: 'profile',
                payload: {
                  afterContent: '测试人物线索，待 owner 批准。',
                  rationale: '原话中的稳定线索',
                  signalKind: 'cat-declared',
                  targetLayer: 'corpus',
                  clientRequestId: 'quiet-profile',
                },
              },
              {
                itemId: 'taste',
                target: 'taste',
                payload: {
                  scene: '守望测试',
                  quote: '界面用词要像家人',
                  tags: ['测试'],
                  dimension: 'authentic-expression',
                  privacy: 'sensitive',
                  clientRequestId: 'quiet-taste',
                },
              },
            ],
          },
        },
        { name: 'cat_cafe_list_memory_matters', args: {} },
        {
          name: 'cat_cafe_read_memory_matter',
          args: async () => ({
            matterId:
              (await matter.catalog({ userId: 'watcher-owner', viewer: { type: 'cat', catId: 'codex' } })).items[0]
                ?.matterId ?? 'unavailable-test-matter',
          }),
        },
      ];
      const session = await f.run(source, AbortSignal.timeout(30000));
      assert.equal(session.watcherState.afterSequence, source.settledSequence);
      assert.equal(f.enqueues.length, 0);
      const toolResults = f.requests
        .at(-1)
        .body.input.filter((item) => item.type === 'custom_tool_call_output')
        .map((item) => String(item.output).slice(0, 600));
      assert.equal(
        (await profile.listPending('watcher-owner')).length,
        1,
        `quiet still follows the original approval lane: ${JSON.stringify(toolResults)}`,
      );
      assert.equal((await tastes.listPending('watcher-owner')).length, 1);
      const pages = await matter.catalog({ userId: 'watcher-owner', viewer: { type: 'cat', catId: 'codex' } });
      assert.equal(pages.items.length, 1);
      const page = await matter.project(
        { userId: 'watcher-owner', viewer: { type: 'cat', catId: 'codex' } },
        pages.items[0].matterId,
      );
      assert.equal(page.entries[0].quote, original.content);
    } finally {
      await f.close();
    }
  },
);
