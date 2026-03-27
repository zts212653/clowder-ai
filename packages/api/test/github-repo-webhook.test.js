import './helpers/setup-cat-registry.js';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';

/** Helper: generate valid GitHub HMAC signature */
function sign(secret, body) {
  return 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');
}

// ── Task 3: HMAC Signature Verification ──

describe('verifyGitHubSignature', () => {
  let verifyGitHubSignature;

  it('load module', async () => {
    const mod = await import('../dist/infrastructure/connectors/github-repo-event/verify-signature.js');
    verifyGitHubSignature = mod.verifyGitHubSignature;
    assert.ok(verifyGitHubSignature);
  });

  it('returns true for valid signature', () => {
    const secret = 'test-secret';
    const body = Buffer.from('{"action":"opened"}');
    const sig = sign(secret, body);
    assert.equal(verifyGitHubSignature(secret, body, sig), true);
  });

  it('returns false for invalid signature', () => {
    const body = Buffer.from('{"action":"opened"}');
    assert.equal(verifyGitHubSignature('secret', body, 'sha256=bad'), false);
  });

  it('returns false for missing signature', () => {
    const body = Buffer.from('{}');
    assert.equal(verifyGitHubSignature('secret', body, ''), false);
    assert.equal(verifyGitHubSignature('secret', body, undefined), false);
  });

  it('returns false for wrong prefix', () => {
    const body = Buffer.from('{}');
    const hex = createHmac('sha256', 'secret').update(body).digest('hex');
    assert.equal(verifyGitHubSignature('secret', body, 'sha1=' + hex), false);
  });
});

// ── Task 4: Redis Delivery ID Dedup ──

describe('RedisDeliveryDedup', () => {
  let RedisDeliveryDedup;

  it('load module', async () => {
    const mod = await import('../dist/infrastructure/connectors/github-repo-event/RedisDeliveryDedup.js');
    RedisDeliveryDedup = mod.RedisDeliveryDedup;
    assert.ok(RedisDeliveryDedup);
  });

  /** Minimal Map-based mock for Redis SET NX EX / DEL */
  function createMockRedis() {
    const store = new Map();
    return {
      store,
      async set(key, value, ...args) {
        if (args.includes('NX') && store.has(key)) return null;
        store.set(key, value);
        return 'OK';
      },
      async del(key) {
        return store.delete(key) ? 1 : 0;
      },
    };
  }

  it('claim succeeds for new delivery ID', async () => {
    const redis = createMockRedis();
    const dedup = new RedisDeliveryDedup(redis);
    assert.equal(await dedup.claim('delivery-001'), true);
  });

  it('claim fails for already-claimed delivery ID', async () => {
    const redis = createMockRedis();
    const dedup = new RedisDeliveryDedup(redis);
    await dedup.claim('delivery-001');
    assert.equal(await dedup.claim('delivery-001'), false);
  });

  it('confirm updates value to confirmed', async () => {
    const redis = createMockRedis();
    const dedup = new RedisDeliveryDedup(redis);
    await dedup.claim('delivery-001');
    await dedup.confirm('delivery-001');
    assert.equal(redis.store.get('f141:delivery:delivery-001'), 'confirmed');
  });

  it('rollback removes claim so retry can succeed', async () => {
    const redis = createMockRedis();
    const dedup = new RedisDeliveryDedup(redis);
    await dedup.claim('delivery-001');
    await dedup.rollback('delivery-001');
    assert.equal(await dedup.claim('delivery-001'), true);
  });
});

// ── Task 6: GitHubRepoWebhookHandler ──

describe('GitHubRepoWebhookHandler', () => {
  let GitHubRepoWebhookHandler;

  it('load module', async () => {
    const mod = await import('../dist/infrastructure/connectors/github-repo-event/GitHubRepoWebhookHandler.js');
    GitHubRepoWebhookHandler = mod.GitHubRepoWebhookHandler;
    assert.ok(GitHubRepoWebhookHandler);
  });

  const SECRET = 'test-secret-key';
  const CONFIG = {
    webhookSecret: SECRET,
    repoAllowlist: ['zts212653/clowder-ai'],
    inboxCatId: 'cat-maine-coon',
    defaultUserId: 'user-maintainer',
  };

  function makePRPayload(action, overrides = {}) {
    return {
      action,
      repository: { full_name: 'zts212653/clowder-ai' },
      sender: { login: 'contributor', id: 12345 },
      pull_request: {
        number: 42,
        title: 'Add feature X',
        html_url: 'https://github.com/zts212653/clowder-ai/pull/42',
        user: { login: 'contributor', id: 12345 },
        author_association: 'NONE',
        draft: false,
        ...overrides,
      },
    };
  }

  function makeIssuePayload(action) {
    return {
      action,
      repository: { full_name: 'zts212653/clowder-ai' },
      sender: { login: 'reporter', id: 67890 },
      issue: {
        number: 7,
        title: 'Bug report',
        html_url: 'https://github.com/zts212653/clowder-ai/issues/7',
        user: { login: 'reporter', id: 67890 },
        author_association: 'NONE',
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

  function createMockDeps() {
    const deliveredMessages = [];
    const triggeredCalls = [];
    const boundThreads = new Map();
    const redisStore = new Map();
    let threadCounter = 0;
    return {
      deliveredMessages,
      triggeredCalls,
      boundThreads,
      deps: {
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
        threadStore: {
          async create(userId, title) {
            threadCounter++;
            return { id: `thread-${threadCounter}`, title, createdBy: userId };
          },
        },
        deliverFn: async (_deps, input) => {
          deliveredMessages.push(input);
          return { messageId: `msg-${deliveredMessages.length}`, content: input.content };
        },
        invokeTrigger: {
          trigger(...args) {
            triggeredCalls.push(args);
          },
        },
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
          _store: redisStore,
          async set(key, value, ...args) {
            if (args.includes('NX') && redisStore.has(key)) return null;
            redisStore.set(key, value);
            return 'OK';
          },
          async del(key) {
            return redisStore.delete(key) ? 1 : 0;
          },
        },
      },
    };
  }

  it('processes pull_request.opened event (AC-A1)', async () => {
    const { deps, deliveredMessages, triggeredCalls } = createMockDeps();
    const handler = new GitHubRepoWebhookHandler(CONFIG, deps);
    const body = makePRPayload('opened');
    const { headers, raw } = makeHeaders('pull_request', 'delivery-001', body);

    const result = await handler.handleWebhook(body, headers, raw);

    assert.equal(result.kind, 'processed');
    assert.equal(deliveredMessages.length, 1);
    assert.ok(deliveredMessages[0].content.includes('#42'));
    assert.equal(triggeredCalls.length, 1);
  });

  it('processes issues.opened event (AC-A2)', async () => {
    const { deps, deliveredMessages } = createMockDeps();
    const handler = new GitHubRepoWebhookHandler(CONFIG, deps);
    const body = makeIssuePayload('opened');
    const { headers, raw } = makeHeaders('issues', 'delivery-002', body);

    const result = await handler.handleWebhook(body, headers, raw);

    assert.equal(result.kind, 'processed');
    assert.equal(deliveredMessages.length, 1);
    assert.ok(deliveredMessages[0].content.includes('#7'));
  });

  it('processes pull_request.ready_for_review event (AC-A3)', async () => {
    const { deps, deliveredMessages } = createMockDeps();
    const handler = new GitHubRepoWebhookHandler(CONFIG, deps);
    const body = makePRPayload('ready_for_review');
    const { headers, raw } = makeHeaders('pull_request', 'delivery-003', body);

    const result = await handler.handleWebhook(body, headers, raw);

    assert.equal(result.kind, 'processed');
    assert.ok(deliveredMessages[0].content.includes('ready for review'));
  });

  it('rejects invalid HMAC signature (AC-A4)', async () => {
    const { deps, deliveredMessages } = createMockDeps();
    const handler = new GitHubRepoWebhookHandler(CONFIG, deps);
    const body = makePRPayload('opened');
    const raw = Buffer.from(JSON.stringify(body));
    const headers = {
      'x-github-event': 'pull_request',
      'x-github-delivery': 'delivery-bad',
      'x-hub-signature-256': 'sha256=invalid',
    };

    const result = await handler.handleWebhook(body, headers, raw);

    assert.equal(result.kind, 'error');
    assert.equal(result.status, 403);
    assert.equal(deliveredMessages.length, 0);
  });

  it('deduplicates by delivery ID (AC-A5)', async () => {
    const { deps, deliveredMessages } = createMockDeps();
    const handler = new GitHubRepoWebhookHandler(CONFIG, deps);
    const body = makePRPayload('opened');
    const { headers, raw } = makeHeaders('pull_request', 'delivery-dup', body);

    await handler.handleWebhook(body, headers, raw);
    const result2 = await handler.handleWebhook(body, headers, raw);

    assert.equal(result2.kind, 'skipped');
    assert.ok(result2.reason.includes('Duplicate'));
    assert.equal(deliveredMessages.length, 1);
  });

  it('sets correct ConnectorSource (AC-A6)', async () => {
    const { deps, deliveredMessages } = createMockDeps();
    const handler = new GitHubRepoWebhookHandler(CONFIG, deps);
    const body = makePRPayload('opened');
    const { headers, raw } = makeHeaders('pull_request', 'delivery-src', body);

    await handler.handleWebhook(body, headers, raw);

    const source = deliveredMessages[0].source;
    assert.equal(source.connector, 'github-repo-event');
    assert.equal(source.label, 'Repo Inbox');
    assert.equal(source.icon, 'github');
    assert.equal(source.sender.name, 'contributor');
    assert.ok(source.url.includes('/pull/42'));
  });

  it('calls invokeTrigger.trigger after delivery (KD-17)', async () => {
    const { deps, triggeredCalls } = createMockDeps();
    const handler = new GitHubRepoWebhookHandler(CONFIG, deps);
    const body = makeIssuePayload('opened');
    const { headers, raw } = makeHeaders('issues', 'delivery-trig', body);

    await handler.handleWebhook(body, headers, raw);

    assert.equal(triggeredCalls.length, 1);
    const [threadId, catId] = triggeredCalls[0];
    assert.ok(threadId.startsWith('thread-'));
    assert.equal(catId, 'cat-maine-coon');
  });

  it('skips unhandled event types', async () => {
    const { deps } = createMockDeps();
    const handler = new GitHubRepoWebhookHandler(CONFIG, deps);
    const raw = Buffer.from('{}');
    const headers = {
      'x-github-event': 'push',
      'x-github-delivery': 'delivery-push',
      'x-hub-signature-256': sign(SECRET, raw),
    };

    const result = await handler.handleWebhook({}, headers, raw);

    assert.equal(result.kind, 'skipped');
    assert.ok(result.reason.includes('push'));
  });

  it('skips repos not in allowlist', async () => {
    const { deps } = createMockDeps();
    const handler = new GitHubRepoWebhookHandler(CONFIG, deps);
    const body = {
      action: 'opened',
      repository: { full_name: 'stranger/repo' },
      sender: { login: 'x', id: 1 },
      pull_request: {
        number: 1,
        title: 'PR',
        html_url: 'https://github.com/stranger/repo/pull/1',
        user: { login: 'x', id: 1 },
        author_association: 'NONE',
        draft: false,
      },
    };
    const { headers, raw } = makeHeaders('pull_request', 'delivery-deny', body);

    const result = await handler.handleWebhook(body, headers, raw);

    assert.equal(result.kind, 'skipped');
    assert.ok(result.reason.includes('allowlist'));
  });

  it('skips draft PRs on opened', async () => {
    const { deps } = createMockDeps();
    const handler = new GitHubRepoWebhookHandler(CONFIG, deps);
    const body = makePRPayload('opened', { draft: true });
    const { headers, raw } = makeHeaders('pull_request', 'delivery-draft', body);

    const result = await handler.handleWebhook(body, headers, raw);

    assert.equal(result.kind, 'skipped');
    assert.ok(result.reason.includes('draft'));
  });

  it('creates new inbox thread on first event for a repo (KD-14)', async () => {
    const { deps, boundThreads } = createMockDeps();
    const handler = new GitHubRepoWebhookHandler(CONFIG, deps);
    const body = makeIssuePayload('opened');
    const { headers, raw } = makeHeaders('issues', 'delivery-new-thread', body);

    await handler.handleWebhook(body, headers, raw);

    const binding = boundThreads.get('github-repo-event:zts212653/clowder-ai');
    assert.ok(binding);
    assert.ok(binding.threadId.startsWith('thread-'));
  });

  it('reuses existing inbox thread for same repo', async () => {
    const { deps, deliveredMessages } = createMockDeps();
    const handler = new GitHubRepoWebhookHandler(CONFIG, deps);

    const body1 = makeIssuePayload('opened');
    const h1 = makeHeaders('issues', 'd-1', body1);
    await handler.handleWebhook(body1, h1.headers, h1.raw);

    const body2 = makePRPayload('opened');
    const h2 = makeHeaders('pull_request', 'd-2', body2);
    await handler.handleWebhook(body2, h2.headers, h2.raw);

    assert.equal(deliveredMessages[0].threadId, deliveredMessages[1].threadId);
  });

  // ── P1-3: confirm failure must NOT rollback after successful delivery ──
  it('confirm failure does not rollback after delivery (P1-3)', async () => {
    const { deps, deliveredMessages } = createMockDeps();
    deps.dedup.confirm = async () => {
      throw new Error('Redis connection lost');
    };

    const handler = new GitHubRepoWebhookHandler(CONFIG, deps);
    const body = makePRPayload('opened');
    const { headers, raw } = makeHeaders('pull_request', 'delivery-confirm-fail', body);

    const result = await handler.handleWebhook(body, headers, raw);

    assert.equal(result.kind, 'processed');
    assert.equal(deliveredMessages.length, 1);
    // Claim must NOT have been rolled back — key stays to block retries
    assert.ok(deps.dedup._claimed.has('delivery-confirm-fail'));
  });

  // ── P1-1: concurrent first events must not create orphan threads (KD-20) ──
  it('concurrent first events for same repo converge on one thread (KD-20)', async () => {
    const { deps, deliveredMessages } = createMockDeps();
    let createCount = 0;
    const origCreate = deps.threadStore.create.bind(deps.threadStore);
    deps.threadStore.create = async (...args) => {
      createCount++;
      await new Promise((r) => setTimeout(r, 10));
      return origCreate(...args);
    };

    const handler = new GitHubRepoWebhookHandler(CONFIG, deps);

    const body1 = makePRPayload('opened');
    const h1 = makeHeaders('pull_request', 'd-race-1', body1);
    const body2 = makeIssuePayload('opened');
    const h2 = makeHeaders('issues', 'd-race-2', body2);

    const [r1, r2] = await Promise.all([
      handler.handleWebhook(body1, h1.headers, h1.raw),
      handler.handleWebhook(body2, h2.headers, h2.raw),
    ]);

    assert.equal(r1.kind, 'processed');
    assert.equal(r2.kind, 'processed');
    assert.equal(deliveredMessages[0].threadId, deliveredMessages[1].threadId);
    assert.equal(createCount, 1, 'should create exactly one thread');
  });

  // ── P2-1: reject missing or empty delivery ID ──
  it('rejects missing delivery ID header (P2-1)', async () => {
    const { deps } = createMockDeps();
    const handler = new GitHubRepoWebhookHandler(CONFIG, deps);
    const body = makePRPayload('opened');
    const raw = Buffer.from(JSON.stringify(body));

    // Missing header
    const r1 = await handler.handleWebhook(
      body,
      {
        'x-github-event': 'pull_request',
        'x-hub-signature-256': sign(SECRET, raw),
      },
      raw,
    );
    assert.equal(r1.kind, 'error');
    assert.equal(r1.status, 400);

    // Empty header
    const r2 = await handler.handleWebhook(
      body,
      {
        'x-github-event': 'pull_request',
        'x-github-delivery': '',
        'x-hub-signature-256': sign(SECRET, raw),
      },
      raw,
    );
    assert.equal(r2.kind, 'error');
    assert.equal(r2.status, 400);
  });

  // ── P2-1: reject payload with missing subject ──
  it('rejects payload with missing subject (P2-1)', async () => {
    const { deps } = createMockDeps();
    const handler = new GitHubRepoWebhookHandler(CONFIG, deps);
    const body = {
      action: 'opened',
      repository: { full_name: 'zts212653/clowder-ai' },
      sender: { login: 'x', id: 1 },
      // No pull_request field — malformed
    };
    const raw = Buffer.from(JSON.stringify(body));
    const headers = {
      'x-github-event': 'pull_request',
      'x-github-delivery': 'delivery-no-subject',
      'x-hub-signature-256': sign(SECRET, raw),
    };

    const result = await handler.handleWebhook(body, headers, raw);

    assert.equal(result.kind, 'error');
    assert.equal(result.status, 400);
  });

  // ── Phase B bridge: marks business dedup after delivery ──
  it('marks reconciliation dedup after successful delivery (Phase B bridge)', async () => {
    const { deps, deliveredMessages } = createMockDeps();
    const markCalls = [];
    deps.reconciliationDedup = {
      async markNotified(repo, type, number) {
        markCalls.push({ repo, type, number });
      },
    };

    const handler = new GitHubRepoWebhookHandler(CONFIG, deps);
    const body = makePRPayload('opened');
    const { headers, raw } = makeHeaders('pull_request', 'delivery-recon-1', body);

    const result = await handler.handleWebhook(body, headers, raw);

    assert.equal(result.kind, 'processed');
    assert.equal(markCalls.length, 1);
    assert.deepEqual(markCalls[0], {
      repo: 'zts212653/clowder-ai',
      type: 'pr',
      number: 42,
    });
  });

  it('works without reconciliation dedup (backward compat)', async () => {
    const { deps, deliveredMessages } = createMockDeps();
    // No reconciliationDedup set — should work fine
    const handler = new GitHubRepoWebhookHandler(CONFIG, deps);
    const body = makePRPayload('opened');
    const { headers, raw } = makeHeaders('pull_request', 'delivery-no-recon', body);

    const result = await handler.handleWebhook(body, headers, raw);
    assert.equal(result.kind, 'processed');
    assert.equal(deliveredMessages.length, 1);
  });
});
