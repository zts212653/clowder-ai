import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

let extractIssueFixEvidence;
let isCriticalIssueSignal;
let selectIssueFixReadiness;
let validateIssueFixEvidence;
let buildIssueCommentContent;
try {
  const mod = await import('../dist/domains/community/issue-analysis/issue-fix-evidence.js');
  extractIssueFixEvidence = mod.extractIssueFixEvidence;
  isCriticalIssueSignal = mod.isCriticalIssueSignal;
  selectIssueFixReadiness = mod.selectIssueFixReadiness;
  validateIssueFixEvidence = mod.validateIssueFixEvidence;
  ({ buildIssueCommentContent } = await import('../dist/infrastructure/email/IssueCommentRouter.js'));
} catch {
  // RED phase: implementation does not exist yet.
}

function commentEvent(body, fixEvidence) {
  return {
    sourceEventId: `comment:${body}`,
    subjectKey: 'issue:owner/repo#42',
    kind: 'issue.commented',
    classification: 'informational',
    payload: { body, ...(fixEvidence ? { fixEvidence } : {}) },
    at: 1_700_000_000_000,
  };
}

describe('F168 AC-F12 issue fix evidence', () => {
  it('rejects prose-only fixed claims instead of declaring re-review ready', () => {
    assert.ok(selectIssueFixReadiness, 'selector must be importable');
    assert.deepStrictEqual(selectIssueFixReadiness({ events: [commentEvent('This is fixed now.')] }), {
      kind: 'waiting',
      reason: 'fix_claim_without_evidence',
    });
  });

  it('accepts a GitHub PR URL embedded in the fix claim', () => {
    assert.ok(extractIssueFixEvidence, 'extractor must be importable');
    const body = 'Fixed in https://github.com/acme/widgets/pull/87';
    const evidence = extractIssueFixEvidence(body);
    assert.deepStrictEqual(evidence, {
      kind: 'pull_request',
      url: 'https://github.com/acme/widgets/pull/87',
      number: 87,
    });
    assert.deepStrictEqual(selectIssueFixReadiness({ events: [commentEvent(body)] }), {
      kind: 'ready',
      evidence,
    });
  });

  it('accepts a merged linked PR projection when a fix claim has no URL', () => {
    const result = selectIssueFixReadiness({
      events: [commentEvent('Resolved upstream, please verify.')],
      linkedPullRequests: [
        { repo: 'acme/widgets', type: 'pr', number: 91, subjectKey: 'pr:acme/widgets#91', state: 'fixed' },
      ],
    });
    assert.deepStrictEqual(result, {
      kind: 'ready',
      evidence: {
        kind: 'pull_request',
        url: 'https://github.com/acme/widgets/pull/91',
        number: 91,
      },
    });
  });

  it('accepts explicit structured commit, release, and reproduction evidence', () => {
    assert.ok(validateIssueFixEvidence, 'validator must be importable');
    const fixtures = [
      { kind: 'commit', sha: '0123456789abcdef0123456789abcdef01234567' },
      { kind: 'release', tag: 'v2.4.0', url: 'https://github.com/acme/widgets/releases/tag/v2.4.0' },
      { kind: 'reproduction', evidence: 'Re-run the published repro: all 18 assertions now pass.' },
    ];
    for (const evidence of fixtures) {
      assert.deepStrictEqual(validateIssueFixEvidence(evidence), evidence);
      assert.deepStrictEqual(
        selectIssueFixReadiness({
          events: [
            {
              ...commentEvent('Evidence recorded.'),
              kind: 'case.fix_evidence_recorded',
              classification: 'needs-owner',
              payload: { fixEvidence: evidence },
            },
          ],
        }),
        { kind: 'ready', evidence },
      );
    }
  });

  it('rejects malformed or mismatched structured evidence', () => {
    const fixtures = [
      { kind: 'pull_request', url: 'https://evil.example/pull/87', number: 87 },
      { kind: 'pull_request', url: 'https://github.com/acme/widgets/pull/88', number: 87 },
      { kind: 'commit', sha: 'not-a-sha' },
      { kind: 'release', tag: 'v2.4.0', url: 'javascript:alert(1)' },
      { kind: 'reproduction', evidence: '   ' },
    ];
    for (const evidence of fixtures) {
      assert.strictEqual(validateIssueFixEvidence(evidence), null);
    }
    assert.deepStrictEqual(
      selectIssueFixReadiness({
        events: [
          {
            ...commentEvent('Fixed.'),
            kind: 'case.fix_evidence_recorded',
            classification: 'needs-owner',
            payload: { fixEvidence: fixtures[0] },
          },
        ],
      }),
      { kind: 'waiting', reason: 'invalid_evidence' },
    );
  });

  it('treats malformed percent-encoded release tags as invalid evidence without throwing', () => {
    const malformedRelease = 'Released in https://github.com/acme/widgets/releases/tag/%E0%A4%A';

    assert.doesNotThrow(() => extractIssueFixEvidence(malformedRelease));
    assert.strictEqual(extractIssueFixEvidence(malformedRelease), null);
    assert.strictEqual(
      validateIssueFixEvidence({
        kind: 'release',
        tag: 'broken',
        url: 'https://github.com/acme/widgets/releases/tag/%E0%A4%A',
      }),
      null,
    );
    assert.deepStrictEqual(selectIssueFixReadiness({ events: [commentEvent(malformedRelease)] }), {
      kind: 'waiting',
      reason: 'fix_claim_without_evidence',
    });
  });

  it('recognizes P0, security, and data-loss signals for silence overrides', () => {
    assert.ok(isCriticalIssueSignal, 'critical-signal predicate must be importable');
    assert.strictEqual(isCriticalIssueSignal('P0: remote code execution is reproducible'), true);
    assert.strictEqual(isCriticalIssueSignal('Security advisory: auth bypass in callback verification'), true);
    assert.strictEqual(isCriticalIssueSignal('升级后数据丢失，无法恢复'), true);
    assert.strictEqual(isCriticalIssueSignal('Routine setup progress update'), false);
  });

  it('tells the assigned reviewer whether a fix claim is ready or still missing evidence', () => {
    const ready = buildIssueCommentContent({
      repoFullName: 'acme/widgets',
      issueNumber: 42,
      newComments: [
        {
          id: 1,
          author: 'maintainer',
          body: 'Fixed in https://github.com/acme/widgets/pull/87',
          createdAt: '2026-07-14T00:00:00Z',
        },
      ],
    });
    assert.match(ready, /ready for re-review/i);
    assert.match(ready, /https:\/\/github\.com\/acme\/widgets\/pull\/87/);

    const waiting = buildIssueCommentContent({
      repoFullName: 'acme/widgets',
      issueNumber: 42,
      newComments: [
        {
          id: 2,
          author: 'maintainer',
          body: 'This is fixed now.',
          createdAt: '2026-07-14T00:01:00Z',
        },
      ],
    });
    assert.match(waiting, /evidence missing/i);
    assert.doesNotMatch(waiting, /ready for re-review/i);
  });
});
