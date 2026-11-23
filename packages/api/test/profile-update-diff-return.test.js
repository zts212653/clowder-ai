import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { canonicalTestMessageInput } from './helpers/message-from-fixtures.js';

describe('profile-update mechanical diff in cat return and card readback', () => {
  let dataDir;
  let app;
  let registry;
  let store;
  let messageStore;
  let repository;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'f231-diff-return-'));
    const routeMod = await import('../dist/routes/callback-propose-profile-update-routes.js');
    const rememberMod = await import('../dist/routes/callback-remember-routes.js');
    const RegMod = await import('../dist/domains/cats/services/agents/invocation/InvocationRegistry.js');
    const StoreMod = await import('../dist/domains/cats/services/stores/ports/ProfileUpdateProposalStore.js');
    const MsgMod = await import('../dist/domains/cats/services/stores/ports/MessageStore.js');
    const authMod = await import('../dist/routes/callback-auth-prehandler.js');
    const RepoMod = await import('../dist/domains/cats/services/profile/ProfileRepository.js');

    repository = new RepoMod.FileProfileRepository({
      dataDir,
      relationshipKeyForCat: () => 'ragdoll',
    });
    registry = new RegMod.InvocationRegistry();
    store = new StoreMod.InMemoryProfileUpdateProposalStore();
    messageStore = new MsgMod.MessageStore();
    const socketManager = { emitToUser() {}, broadcastToRoom() {} };

    app = Fastify();
    authMod.registerCallbackAuthHook(app, registry);
    routeMod.registerCallbackProposeProfileUpdateRoutes(app, {
      registry,
      proposalStore: store,
      messageStore,
      socketManager,
      repository,
    });
    rememberMod.registerCallbackRememberRoutes(app, {
      registry,
      messageStore,
      socketManager,
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns exact line diff summary and revisions through cat_cafe_remember and dedup retry before owner approval', async () => {
    const corpusPath = join(repository.profileDir('owner'), 'corpus', 'shared-facts.md');
    mkdirSync(join(corpusPath, '..'), { recursive: true });
    const beforeContent = [
      '# 共享事实',
      '- 额度告急时先告知剩余比例，不要静默降档',
      '- 默认中文沟通',
      '- 复杂概念先用分层图解把限定条件讲得更清楚',
      '',
    ].join('\n');
    writeFileSync(corpusPath, beforeContent, 'utf8');

    const afterContent = [
      '# 共享事实',
      '- 额度告急时先告知剩余比例，不要静默降档的',
      '- 默认中文沟通',
      '- 四支柱：everywhere / connect / grow / 主动',
      '- 复杂概念先用分层图解把限定条件讲清楚更清楚',
      '',
    ].join('\n');

    const origin = messageStore.append(
      canonicalTestMessageInput({
        userId: 'owner',
        catId: null,
        threadId: 'thread_1',
        content: '把四支柱也补进共享画像',
        mentions: [],
        timestamp: Date.now(),
      }),
    );
    const auth = await registry.create('owner', 'sonnet', 'thread_1', undefined, undefined, undefined, origin.id);
    const headers = {
      'x-invocation-id': auth.invocationId,
      'x-callback-token': auth.callbackToken,
      'content-type': 'application/json',
    };

    const payload = {
      clientRequestId: 'req-corpus-diff-1',
      items: [
        {
          itemId: 'corpus-1',
          target: 'profile',
          payload: {
            targetLayer: 'corpus',
            afterContent,
            rationale: '补入四支柱原话',
            signalKind: 'cvo-instructed',
          },
        },
      ],
    };

    const res = await app.inject({ method: 'POST', url: '/api/callbacks/remember', headers, payload });
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    const profileResult = body.results[0].result;

    assert.ok(profileResult.diff, 'propose return includes mechanical diff for cat self-check');
    assert.equal(profileResult.diff.addedLineCount, 3);
    assert.equal(profileResult.diff.removedLineCount, 2);
    assert.equal(profileResult.diff.identical, false);
    assert.match(profileResult.diff.beforeRevision, /^sha256:[a-f0-9]{64}$/);
    assert.match(profileResult.diff.afterRevision, /^sha256:[a-f0-9]{64}$/);
    assert.notEqual(profileResult.diff.beforeRevision, profileResult.diff.afterRevision);
    assert.match(profileResult.diff.unifiedDiff, /-- 额度告急时先告知剩余比例，不要静默降档/);
    assert.match(profileResult.diff.unifiedDiff, /\+- 额度告急时先告知剩余比例，不要静默降档的/);
    assert.match(profileResult.diff.unifiedDiff, /\+- 四支柱：everywhere \/ connect \/ grow \/ 主动/);
    assert.match(profileResult.diff.unifiedDiff, /-- 复杂概念先用分层图解把限定条件讲得更清楚/);
    assert.match(profileResult.diff.unifiedDiff, /\+- 复杂概念先用分层图解把限定条件讲清楚更清楚/);

    // Dedup retry returns the same diff summary so retried calls keep mechanical verification.
    const retry = await app.inject({ method: 'POST', url: '/api/callbacks/remember', headers, payload });
    assert.equal(retry.statusCode, 200, retry.body);
    assert.deepEqual(retry.json().results[0].result.diff, profileResult.diff);

    // Card readback via messageStore also carries the unified diff block in bodyMarkdown.
    const cardMessage = await messageStore.getById(profileResult.messageId);
    const cardBlock = cardMessage.extra.rich.blocks.find((b) => b.id === `profile-update-${profileResult.proposalId}`);
    assert.ok(cardBlock, 'approval card persisted in thread');
    assert.match(cardBlock.bodyMarkdown, /\+- 四支柱：everywhere \/ connect \/ grow \/ 主动/);
    assert.match(cardBlock.bodyMarkdown, /\+- 额度告急时先告知剩余比例，不要静默降档的/);
  });
});
