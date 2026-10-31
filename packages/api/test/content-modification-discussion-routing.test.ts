import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { catRegistry, createCatId } from '@cat-cafe/shared';
import { AgentRouter } from '../src/domains/cats/services/agents/routing/AgentRouter.js';
import { buildMessageContentBlocks, sendMessageSchema } from '../src/routes/messages.schema.js';
import { migrateRouterOpts } from './helpers/agent-registry-helpers.js';
import { mediaMessageFixture } from './helpers/media-message-fixture.js';

// The Next package is CommonJS to this Node/tsx harness; consume its actual producer, not a copied fixture.
const {
  artifactDiscussionMessage,
}: typeof import('../../web/src/components/content-review/artifact-discussion-message.js') = createRequire(
  import.meta.url,
)('../../web/src/components/content-review/artifact-discussion-message.ts');

for (const history of ['recent_replier', 'previous_user_mentions']) {
  for (const inertOwner of ['none', 'quote', 'code', 'unfinished-code'] as const) {
    test(`Task change discussion reaches its canonical owner despite ${history} naming another cat${inertOwner === 'none' ? '' : ` and ${inertOwner}`}`, async (t) => {
      const f = await mediaMessageFixture(t);
      const ownerConfig = catRegistry.getOrThrow('codex-astra').config;
      const originalPatterns = ownerConfig.mentionPatterns;
      ownerConfig.mentionPatterns = ['@original-owner'];
      t.after(() => {
        ownerConfig.mentionPatterns = originalPatterns;
      });
      const other = createCatId('codex');
      f.threads.addParticipants(f.thread.id, [other]);
      f.threads.updateParticipantActivity(f.thread.id, other, true);
      if (history === 'previous_user_mentions')
        f.messages.append({
          userId: 'operator',
          from: { kind: 'user', userId: 'operator' },
          threadId: f.thread.id,
          content: '@codex 先看别的事',
          mentions: [other],
          timestamp: Date.now(),
        });
      const service = {
        async *invoke() {
          throw new Error('This test must not start a model');
        },
      };
      const options = await migrateRouterOpts({
        claudeService: service,
        codexService: service,
        geminiService: service,
        registry: f.registry,
        threadStore: f.threads,
        messageStore: f.messages,
      });
      options.agentRegistry.register('codex-astra', service);
      const router = new AgentRouter(options);
      const draft = {
        none: '保留我的原话\n改一下这件作品',
        quote: '保留我的原话\n> @original-owner\n改一下这件作品',
        code: '保留我的原话\n```text\n@original-owner\n```\n改一下这件作品',
        'unfinished-code': '保留我的原话\n```text\n代码示例',
      }[inertOwner];
      const savedReason = inertOwner === 'unfinished-code' ? '关闭代码示例\n```\n保留说明' : undefined;
      const before = await router.previewTargets(draft, { threadId: f.thread.id });
      assert.deepEqual(before.targetCats, [other]);
      assert.equal(before.reason.kind, history);

      const unaddressed = f.messages.append({
        userId: 'operator',
        from: { kind: 'user', userId: 'operator' },
        threadId: f.thread.id,
        content: draft,
        mentions: before.targetCats,
        timestamp: Date.now(),
        contentBlocks: buildMessageContentBlocks(draft, [f.attachment], []),
      });
      await assert.rejects(f.takeOver(unaddressed.id), /not_found/);
      await assert.rejects(
        f.integration.requests.takeOver(
          { sourceMessageId: unaddressed.id, operationId: randomUUID() },
          { ...f.cat, actor: { kind: 'cat', actorId: other } },
        ),
        /task_changed/,
      );

      const content = `${draft}\n${artifactDiscussionMessage(ownerConfig.mentionPatterns[0], draft, savedReason)}`;
      const payload = sendMessageSchema.parse({ content, threadId: f.thread.id, contextAttachments: [f.attachment] });
      const delivery = await router.resolveTargetsAndIntent(payload.content, f.thread.id, { persist: true });
      assert.deepEqual(delivery.targetCats, [createCatId('codex-astra')]);
      const message = f.messages.append({
        userId: 'operator',
        from: { kind: 'user', userId: 'operator' },
        threadId: f.thread.id,
        content: payload.content,
        mentions: delivery.targetCats,
        timestamp: Date.now(),
        contentBlocks: buildMessageContentBlocks(payload.content, payload.contextAttachments, []),
      });
      await assert.rejects(
        f.integration.requests.takeOver(
          { sourceMessageId: message.id, operationId: randomUUID() },
          { ...f.cat, actor: { kind: 'cat', actorId: other } },
        ),
        /not_found/,
      ); // A cat outside the canonical delivered audience cannot take custody.
      const result = await f.takeOver(message.id);
      assert.equal(result.record.progress.task?.taskId, f.taskId);
      assert.equal(result.record.progress.sourceMessageId, message.id);
      assert.equal(result.stage, 'queued');
      assert.ok(result.delivery?.messageId);
      assert.equal(f.messages.getById(message.id)?.content, content);
    });
  }
}
