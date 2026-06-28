/**
 * F167 Phase 5 — GitHubRepoWebhookHandler.ensureInboxThread marker stamping.
 *
 * INV-G5: 新建 inbox thread 后 thread.threadKind === 'gate-keeping'
 * Self-heal: 已存 binding 但 threadKind 缺失 → 补打
 * Idempotent: 已有 'gate-keeping' → 不重复打
 */

import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

function sign(secret, body) {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

describe('F167 Phase 5: ensureInboxThread stamps gate-keeping marker', () => {
  const SECRET = 'test-secret-key';
  const CONFIG = {
    webhookSecret: SECRET,
    repoAllowlist: ['zts212653/clowder-ai'],
    inboxCatId: 'cat-maine-coon',
    defaultUserId: 'user-maintainer',
  };

  function makePRPayload() {
    return {
      action: 'opened',
      repository: { full_name: 'zts212653/clowder-ai' },
      sender: { login: 'contributor', id: 12345 },
      pull_request: {
        number: 42,
        title: 'Add feature X',
        html_url: 'https://github.com/zts212653/clowder-ai/pull/42',
        user: { login: 'contributor', id: 12345 },
        author_association: 'CONTRIBUTOR',
        draft: false,
      },
    };
  }

  function makeHeaders(eventType, deliveryId, body) {
    const raw = Buffer.from(JSON.stringify(body));
    return {
      headers: {
        'x-github-event': eventType,
        'x-github-delivery': deliveryId,
        'x-hub-signature-256': sign(SECRET, raw),
      },
      raw,
    };
  }

  /**
   * Mock threadStore that tracks threadKind state and exposes updateThreadKind calls.
   * Mirrors the in-memory ThreadStore semantics: create → has no kind; updateThreadKind sets/clears.
   */
  function makeMockThreadStore() {
    const threads = new Map();
    let counter = 0;
    const calls = [];
    return {
      threads,
      calls,
      async create(userId, title) {
        counter++;
        const id = `thread-${counter}`;
        threads.set(id, { id, title, createdBy: userId });
        return { id };
      },
      async get(threadId) {
        return threads.get(threadId) ?? null;
      },
      async updateThreadKind(threadId, kind) {
        calls.push({ threadId, kind });
        const thread = threads.get(threadId);
        if (!thread) return;
        if (kind === null) {
          delete thread.threadKind;
        } else {
          thread.threadKind = kind;
        }
      },
    };
  }

  function makeDeps(threadStore) {
    const boundThreads = new Map();
    const redisStore = new Map();
    return {
      bindingStore: {
        async getByExternal(connectorId, externalChatId) {
          return boundThreads.get(`${connectorId}:${externalChatId}`) ?? null;
        },
        async bind(connectorId, externalChatId, threadId, userId) {
          const binding = { connectorId, externalChatId, threadId, userId, createdAt: Date.now() };
          boundThreads.set(`${connectorId}:${externalChatId}`, binding);
          return binding;
        },
      },
      threadStore,
      deliverFn: async (_d, input) => ({ messageId: 'msg-1', content: input.content }),
      invokeTrigger: { trigger() {} },
      dedup: {
        _claimed: new Set(),
        async claim(id) {
          if (this._claimed.has(id)) return false;
          this._claimed.add(id);
          return true;
        },
        async confirm() {},
        async rollback(id) {
          this._claimed.delete(id);
        },
      },
      redis: {
        async set(key, value, ...args) {
          if (args.includes('NX') && redisStore.has(key)) return null;
          redisStore.set(key, value);
          return 'OK';
        },
        async del(key) {
          return redisStore.delete(key) ? 1 : 0;
        },
      },
    };
  }

  it('INV-G5: new inbox thread → threadKind === gate-keeping after first webhook', async () => {
    const { GitHubRepoWebhookHandler } = await import(
      '../dist/infrastructure/connectors/github-repo-event/GitHubRepoWebhookHandler.js'
    );
    const threadStore = makeMockThreadStore();
    const handler = new GitHubRepoWebhookHandler(CONFIG, makeDeps(threadStore));

    const body = makePRPayload();
    const { headers, raw } = makeHeaders('pull_request', 'delivery-marker-1', body);
    const result = await handler.handleWebhook(body, headers, raw);

    assert.equal(result.kind, 'processed');
    assert.equal(threadStore.threads.size, 1, 'one inbox thread created');
    const [thread] = [...threadStore.threads.values()];
    assert.equal(thread.threadKind, 'gate-keeping', 'new inbox thread must be marked gate-keeping');
    // Marker stamped exactly once (no idempotent extra calls during creation)
    assert.equal(threadStore.calls.length, 1);
    assert.equal(threadStore.calls[0].kind, 'gate-keeping');
  });

  it('self-heal: pre-existing binding with missing threadKind → stamped on next webhook', async () => {
    const { GitHubRepoWebhookHandler } = await import(
      '../dist/infrastructure/connectors/github-repo-event/GitHubRepoWebhookHandler.js'
    );
    const threadStore = makeMockThreadStore();
    const deps = makeDeps(threadStore);

    // Simulate pre-rollout state: binding exists but thread has no threadKind
    const preExisting = await threadStore.create(CONFIG.defaultUserId, `Repo Inbox · zts212653/clowder-ai`);
    await deps.bindingStore.bind('github-repo-event', 'zts212653/clowder-ai', preExisting.id, CONFIG.defaultUserId);
    // Reset calls so we observe only the self-heal call:
    threadStore.calls.length = 0;

    const handler = new GitHubRepoWebhookHandler(CONFIG, deps);
    const body = makePRPayload();
    const { headers, raw } = makeHeaders('pull_request', 'delivery-marker-2', body);
    await handler.handleWebhook(body, headers, raw);

    const thread = threadStore.threads.get(preExisting.id);
    assert.equal(thread.threadKind, 'gate-keeping', 'self-heal must stamp the marker');
    assert.equal(threadStore.calls.length, 1, 'exactly one updateThreadKind call (self-heal)');
  });

  it('idempotent: pre-existing binding with threadKind already gate-keeping → no extra updateThreadKind call', async () => {
    const { GitHubRepoWebhookHandler } = await import(
      '../dist/infrastructure/connectors/github-repo-event/GitHubRepoWebhookHandler.js'
    );
    const threadStore = makeMockThreadStore();
    const deps = makeDeps(threadStore);

    const preExisting = await threadStore.create(CONFIG.defaultUserId, `Repo Inbox · zts212653/clowder-ai`);
    await deps.bindingStore.bind('github-repo-event', 'zts212653/clowder-ai', preExisting.id, CONFIG.defaultUserId);
    await threadStore.updateThreadKind(preExisting.id, 'gate-keeping');
    threadStore.calls.length = 0;

    const handler = new GitHubRepoWebhookHandler(CONFIG, deps);
    const body = makePRPayload();
    const { headers, raw } = makeHeaders('pull_request', 'delivery-marker-3', body);
    await handler.handleWebhook(body, headers, raw);

    assert.equal(threadStore.calls.length, 0, 'no redundant updateThreadKind call when marker already set');
  });
});
