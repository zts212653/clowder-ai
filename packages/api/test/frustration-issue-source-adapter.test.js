import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

/**
 * F235 Task 4: FrustrationIssueSourceAdapter — creates a sanitized community
 * issue draft from a confirmed FrustrationIssue.
 */

let createDraftFromFrustrationIssue;
let InMemoryCommunityIssueDraftStore;
let store;

const confirmedIssue = {
  issueId: 'fi_test1',
  status: 'confirmed',
  threadId: 'thread_t1',
  userId: 'usr_u1',
  catId: 'opus',
  signalType: 'cancel_burst',
  signalDetail: { cancelCount: 4, windowMs: 60000 },
  context: {
    recentMessages: [
      { role: 'user', content: 'Why does it keep asking for permission?', timestamp: 1000 },
      { role: 'cat', content: 'I need to run the build command.', timestamp: 2000 },
    ],
  },
  userDescription: 'Permission prompts are too frequent during builds.',
  createdAt: Date.now() - 60000,
  confirmedAt: Date.now() - 30000,
};

const defaultConfig = {
  defaultRepo: 'clowder-ai/cat-cafe',
  repoAllowlist: ['clowder-ai/cat-cafe'],
};

describe('F235: FrustrationIssueSourceAdapter', () => {
  beforeEach(async () => {
    const adapterModule = await import('../dist/domains/community/FrustrationIssueSourceAdapter.js');
    createDraftFromFrustrationIssue = adapterModule.createDraftFromFrustrationIssue;

    const storeModule = await import('../dist/domains/cats/services/stores/memory/InMemoryCommunityIssueDraftStore.js');
    InMemoryCommunityIssueDraftStore = storeModule.InMemoryCommunityIssueDraftStore;
    store = new InMemoryCommunityIssueDraftStore();
  });

  it('creates draft from confirmed issue with sanitized content', async () => {
    const draft = await createDraftFromFrustrationIssue(confirmedIssue, {
      draftStore: store,
      config: defaultConfig,
    });

    assert.equal(draft.status, 'draft');
    assert.ok(draft.draftId.startsWith('cid_'));
    assert.equal(draft.sourceType, 'frustration_issue');
    assert.equal(draft.sourceId, 'fi_test1');
    assert.equal(draft.targetRepo, 'clowder-ai/cat-cafe');
    assert.equal(draft.threadId, 'thread_t1');
    assert.equal(draft.userId, 'usr_u1');
    // Title should contain something meaningful from the issue
    assert.ok(draft.title.length > 0, 'title should be non-empty');
    assert.ok(draft.bodyMarkdown.length > 0, 'body should be non-empty');
  });

  it('includes userDescription in body when available', async () => {
    const draft = await createDraftFromFrustrationIssue(confirmedIssue, {
      draftStore: store,
      config: defaultConfig,
    });
    assert.ok(
      draft.bodyMarkdown.includes('Permission prompts are too frequent'),
      'body should include userDescription',
    );
  });

  it('formats body with signal type context', async () => {
    const draft = await createDraftFromFrustrationIssue(confirmedIssue, {
      draftStore: store,
      config: defaultConfig,
    });
    assert.ok(
      draft.bodyMarkdown.includes('cancel_burst') || draft.bodyMarkdown.includes('Cancel'),
      'body should reference signal type',
    );
  });

  it('rejects non-confirmed issue', async () => {
    const draftIssue = { ...confirmedIssue, status: 'draft' };
    await assert.rejects(
      () =>
        createDraftFromFrustrationIssue(draftIssue, {
          draftStore: store,
          config: defaultConfig,
        }),
      (err) => err.message.includes('confirmed') || err.message.includes('not confirmed'),
    );
  });

  it('rejects skipped issue', async () => {
    const skippedIssue = { ...confirmedIssue, status: 'skipped' };
    await assert.rejects(
      () =>
        createDraftFromFrustrationIssue(skippedIssue, {
          draftStore: store,
          config: defaultConfig,
        }),
      (err) => err.message.includes('confirmed') || err.message.includes('not confirmed'),
    );
  });

  it('sanitizes internal IDs from userDescription (deny-list defense-in-depth)', async () => {
    // B-lite: recentMessages are NOT included in draft body, so internal IDs
    // in messages are safe by construction. Sanitizer still catches patterns
    // that leak through userDescription (user-editable free text).
    const issueWithInternalIds = {
      ...confirmedIssue,
      context: {
        recentMessages: [
          {
            role: 'user',
            content: 'Error in thread_abc123 for session_xyz789 at /home/user/foo',
            timestamp: 1000,
          },
        ],
      },
      userDescription: 'Bug found with token ghp_1234567890abcdefghijklmno in thread_abc123',
    };

    const draft = await createDraftFromFrustrationIssue(issueWithInternalIds, {
      draftStore: store,
      config: defaultConfig,
    });

    // Raw message content should NOT appear at all (B-lite)
    assert.ok(!draft.bodyMarkdown.includes('session_xyz789'), 'raw message content excluded by B-lite');
    assert.ok(!draft.bodyMarkdown.includes('/home/user'), 'raw message content excluded by B-lite');
    // Sanitizer should catch patterns in userDescription
    assert.ok(!draft.bodyMarkdown.includes('ghp_'), 'API key in userDescription should be redacted');
    assert.ok(!draft.bodyMarkdown.includes('thread_abc123'), 'threadId in userDescription should be redacted');
  });

  it('stores draft and can be retrieved by sourceId', async () => {
    const draft = await createDraftFromFrustrationIssue(confirmedIssue, {
      draftStore: store,
      config: defaultConfig,
    });

    const retrieved = await store.getBySourceId('fi_test1');
    assert.ok(retrieved);
    assert.equal(retrieved.draftId, draft.draftId);
  });

  it('rejects duplicate draft for same source (INV-3 via store)', async () => {
    await createDraftFromFrustrationIssue(confirmedIssue, {
      draftStore: store,
      config: defaultConfig,
    });

    await assert.rejects(
      () =>
        createDraftFromFrustrationIssue(confirmedIssue, {
          draftStore: store,
          config: defaultConfig,
        }),
      (err) => err.message.includes('already has') || err.message.includes('duplicate'),
    );
  });

  it('generates issue from cli_error signal type', async () => {
    const cliErrorIssue = {
      ...confirmedIssue,
      signalType: 'cli_error',
      signalDetail: {
        reasonCode: 'ERR_TOOL_TIMEOUT',
        publicSummary: 'Tool execution timed out after 120s',
        publicHint: 'Check network connectivity',
      },
      userDescription: undefined,
    };

    const draft = await createDraftFromFrustrationIssue(cliErrorIssue, {
      draftStore: store,
      config: defaultConfig,
    });

    assert.ok(draft.title.length > 0);
    assert.ok(draft.bodyMarkdown.length > 0);
    // Should include the public summary in the body
    assert.ok(
      draft.bodyMarkdown.includes('timed out') || draft.bodyMarkdown.includes('ERR_TOOL_TIMEOUT'),
      'body should reference the error',
    );
  });

  it('adds "Reported via Clowder AI" footer', async () => {
    const draft = await createDraftFromFrustrationIssue(confirmedIssue, {
      draftStore: store,
      config: defaultConfig,
    });
    assert.ok(
      draft.bodyMarkdown.includes('Reported via Clowder AI') || draft.bodyMarkdown.includes('Clowder AI'),
      'body should have Clowder AI footer',
    );
  });

  // ── B-lite: raw conversation text excluded from public draft ──

  it('does NOT include raw conversation message content (B-lite privacy)', async () => {
    const draft = await createDraftFromFrustrationIssue(confirmedIssue, {
      draftStore: store,
      config: defaultConfig,
    });

    // Raw message content must NOT appear in the public draft body
    assert.ok(
      !draft.bodyMarkdown.includes('Why does it keep asking for permission?'),
      'raw user message content should not appear in public draft',
    );
    assert.ok(
      !draft.bodyMarkdown.includes('I need to run the build command'),
      'raw cat message content should not appear in public draft',
    );
  });

  it('includes conversation context note with message count (B-lite)', async () => {
    const draft = await createDraftFromFrustrationIssue(confirmedIssue, {
      draftStore: store,
      config: defaultConfig,
    });
    assert.ok(
      draft.bodyMarkdown.includes('2 conversation messages were recorded locally'),
      'should note how many messages exist without exposing content',
    );
    assert.ok(
      draft.bodyMarkdown.includes('not included in this public report for privacy'),
      'should explain why messages are excluded',
    );
  });
});
