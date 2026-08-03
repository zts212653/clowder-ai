/**
 * F220 (clowder-ai#972) — bot setup-boilerplate on tracked issues is silent-log, but the
 * filter is EXACT-IDENTITY + CONTENT-AWARE, never a broad `[bot]` blanket.
 *
 * Origin loop: chatgpt-codex-connector[bot] auto-replies ~5s after every maintainer comment
 * on a tracked issue ("To use Codex here…"), waking the owner cat for pure boilerplate; and
 * since the delivery prompt says "reply if needed", a reply re-triggers the bot → unbounded loop.
 *
 * Delta-review finding (@codex-sol, F168 AC-F12 boundary): an earlier version silenced ALL
 * `[bot]` authors via endsWith('[bot]'), which would swallow security/dependency bots
 * (Dependabot/CodeQL) — high-signal that must NOT be dropped. Fix: reuse the existing F140
 * setup-noise filter (`createSetupNoiseFilter` + `GITHUB_SETUP_NOISE_BOT_LOGINS`), wired into
 * the issue path via `isNoiseComment` exactly like the PR-review path (ReviewFeedbackTaskSpec).
 *
 * Contract proven here:
 *   - allowlisted bot + setup boilerplate + no real content → silent-log (collected, not woken).
 *   - NON-allowlisted bot (e.g. dependabot) → DELIVERED (high-signal preserved).
 *   - allowlisted bot whose body ALSO has real `codex review` content → DELIVERED (content-gate).
 *   - real human contributor → DELIVERED.
 *   - decideDelivery itself does NO bot classification (that stays association-only).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const { decideDelivery } = await import('../dist/domains/community/community-delivery-policy.js');
const { createIssueCommentTaskSpec } = await import('../dist/infrastructure/email/IssueCommentTaskSpec.js');
const { createSetupNoiseFilter } = await import('../dist/infrastructure/email/setup-noise-filter.js');

// Wire the SAME shared setup-noise filter the production issue path uses, with a test allowlist.
const setupNoise = createSetupNoiseFilter(['chatgpt-codex-connector[bot]']);
const isNoiseComment = (c) => setupNoise({ author: c.author, body: c.body, commentType: 'conversation' });

// --- stubs (mirror test/f168-phase-b-dual-cursor.test.js) --------------------

function makeTaskStore() {
  const tasks = new Map();
  const patches = [];
  return {
    tasks,
    patches,
    async listByKind(kind) {
      return [...tasks.values()].filter((t) => t.kind === kind && t.status !== 'done');
    },
    async update(id, patch) {
      const t = tasks.get(id);
      if (t) tasks.set(id, { ...t, ...patch });
    },
    async patchAutomationState(id, patch) {
      patches.push({ id, patch });
      const t = tasks.get(id);
      if (t) {
        const merged = { ...t.automationState };
        for (const [k, v] of Object.entries(patch)) merged[k] = { ...(merged[k] ?? {}), ...v };
        tasks.set(id, { ...t, automationState: merged });
      }
    },
    addTask(task) {
      tasks.set(task.id, task);
    },
  };
}

function makeRouter() {
  const calls = [];
  return {
    calls,
    async route(signal, tracking) {
      calls.push({ signal, tracking });
      return {
        kind: 'notified',
        threadId: tracking.threadId,
        catId: tracking.catId,
        messageId: 'msg-1',
        content: 'stub',
      };
    },
  };
}

function makeEventLog() {
  const events = [];
  return {
    events,
    async append(event) {
      events.push(event);
      return { appended: true, sequence: events.length - 1 };
    },
    async read(subjectKey) {
      return events.filter((e) => e.subjectKey === subjectKey);
    },
    async listSubjects() {
      return [...new Set(events.map((e) => e.subjectKey))];
    },
  };
}

function makeTask() {
  return {
    id: 'task-1',
    kind: 'issue_tracking',
    status: 'active',
    subjectKey: 'issue:zts212653/clowder-ai#972',
    threadId: 'thread-1',
    ownerCatId: 'opus-48',
    userId: 'user1',
    automationState: { issue: { lastCommentCursor: 0, lastDeliveredCursor: 0 } },
  };
}

function buildSpec({ comments, taskStore, router, eventLog }) {
  return createIssueCommentTaskSpec({
    taskStore,
    issueCommentRouter: router,
    fetchComments: async () => comments,
    fetchIssueState: async () => 'open',
    eventLog,
    isNoiseComment,
    log: { info: () => {}, error: () => {}, warn: () => {} },
  });
}

const SETUP_BOT = {
  id: 4965387248,
  author: 'chatgpt-codex-connector[bot]',
  authorAssociation: 'NONE',
  body: 'To use Codex here, [create an environment for this repo](https://chatgpt.com/codex/cloud/settings/environments).',
  createdAt: '2026-07-14T04:26:15Z',
};

// Sol's exact concern: a NON-allowlisted bot posting a genuine security alert must NOT be swallowed.
const SECURITY_BOT = {
  id: 4965400000,
  author: 'dependabot[bot]',
  authorAssociation: 'NONE',
  body: 'Bumps lodash from 4.17.20 to 4.17.21 to fix CVE-2021-23337 (command injection).',
  createdAt: '2026-07-14T05:00:00Z',
};

// Content-gate: allowlisted bot whose comment carries real `codex review` content — preserved.
const REVIEW_BOT = {
  id: 4965410000,
  author: 'chatgpt-codex-connector[bot]',
  authorAssociation: 'NONE',
  body: 'To use Codex here, create an environment for this repo. codex review: found 3 blocking issues.',
  createdAt: '2026-07-14T05:10:00Z',
};

const CRITICAL_SETUP_BOT = {
  ...SETUP_BOT,
  id: 4965420000,
  body: 'To use Codex here, create an environment for this repo. Security vulnerability: authentication bypass is reproducible.',
};

const HUMAN = {
  id: 4965286428,
  author: 'mindfn',
  authorAssociation: 'COLLABORATOR',
  body: '## Implementation Plan — F220 Phase 2a',
  createdAt: '2026-07-14T04:05:44Z',
};

// --- policy layer: decideDelivery does NO bot classification ------------------

describe('F220: decideDelivery stays association-only (bot classification is NOT its job)', () => {
  it('bot association NONE → wake-owner (bots are handled by isNoiseComment, not the policy)', () => {
    assert.equal(
      decideDelivery({ state: 'in_progress', eventKind: 'issue.commented', authorAssociation: 'NONE' }),
      'wake-owner',
    );
  });
  it('maintainer OWNER → wake-owner (association is context, not suppression identity)', () => {
    assert.equal(
      decideDelivery({ state: 'in_progress', eventKind: 'issue.commented', authorAssociation: 'OWNER' }),
      'wake-owner',
    );
  });

  it('exact suppression is silent unless the comment is critical', () => {
    assert.equal(
      decideDelivery({
        state: 'awaiting_external',
        eventKind: 'issue.commented',
        suppressionReason: 'exact_setup_noise',
      }),
      'silent-log',
    );
    assert.equal(
      decideDelivery({
        state: 'awaiting_external',
        eventKind: 'issue.commented',
        suppressionReason: 'exact_setup_noise',
        critical: true,
      }),
      'wake-owner',
    );
  });
});

// --- wiring: the part that actually stops the invocation burn ----------------

describe('F220: IssueCommentTaskSpec — exact-identity bot setup-noise, not broad [bot]', () => {
  it('allowlisted bot + setup boilerplate → NOT delivered, but STILL collected', async () => {
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask());
    const router = makeRouter();
    const eventLog = makeEventLog();
    const spec = buildSpec({ comments: [SETUP_BOT], taskStore, router, eventLog });

    const gate = await spec.admission.gate();
    assert.equal(gate.run, false, 'setup boilerplate must not produce a work item');
    assert.equal(router.calls.length, 0, 'must not wake a cat on setup boilerplate');
    assert.equal(eventLog.events.length, 1, 'still collected to the event log (nothing lost)');
    assert.equal(eventLog.events[0].payload.suppressionReason, 'exact_setup_noise');
    assert.equal(eventLog.events[0].payload.critical, false);
    const delivered = taskStore.patches.filter((p) => p.patch.issue?.lastDeliveredCursor !== undefined);
    assert.ok(
      delivered.some((p) => p.patch.issue.lastDeliveredCursor === SETUP_BOT.id),
      'delivery cursor advances past the silent bot comment (no polling churn)',
    );
  });

  it('Sol AC-F12: NON-allowlisted security bot (dependabot) → DELIVERED (high-signal not swallowed)', async () => {
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask());
    const router = makeRouter();
    const eventLog = makeEventLog();
    const spec = buildSpec({ comments: [SECURITY_BOT], taskStore, router, eventLog });

    const gate = await spec.admission.gate();
    assert.equal(gate.run, true, 'a security/dependency bot must still wake the owner');
    assert.deepEqual(
      gate.workItems[0].signal.newComments.map((c) => c.author),
      ['dependabot[bot]'],
    );
    assert.equal(eventLog.events[0].payload.critical, true);
    assert.equal(eventLog.events[0].payload.suppressionReason, undefined);
  });

  it('critical signal bypasses an otherwise exact setup-noise match', async () => {
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask());
    const router = makeRouter();
    const eventLog = makeEventLog();
    const spec = buildSpec({ comments: [CRITICAL_SETUP_BOT], taskStore, router, eventLog });

    const gate = await spec.admission.gate();
    assert.equal(gate.run, true, 'critical security content must wake even from an allowlisted setup bot');
    assert.deepEqual(gate.workItems[0].signal.newComments, [CRITICAL_SETUP_BOT]);
    assert.equal(eventLog.events[0].payload.critical, true);
    assert.equal(eventLog.events[0].payload.suppressionReason, undefined);
  });

  it('content-gate: allowlisted bot whose body has real `codex review` content → DELIVERED', async () => {
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask());
    const router = makeRouter();
    const eventLog = makeEventLog();
    const spec = buildSpec({ comments: [REVIEW_BOT], taskStore, router, eventLog });

    const gate = await spec.admission.gate();
    assert.equal(gate.run, true, 'a bot comment carrying real review content must not be silenced');
  });

  it('regression: real human (COLLABORATOR) in a mixed batch still wakes; only setup bot filtered', async () => {
    const taskStore = makeTaskStore();
    taskStore.addTask(makeTask());
    const router = makeRouter();
    const eventLog = makeEventLog();
    const spec = buildSpec({ comments: [HUMAN, SETUP_BOT], taskStore, router, eventLog });

    const gate = await spec.admission.gate();
    assert.equal(gate.run, true);
    assert.deepEqual(
      gate.workItems[0].signal.newComments.map((c) => c.author),
      ['mindfn'],
      'human delivered; only the allowlisted setup-boilerplate bot is filtered out',
    );
  });
});
