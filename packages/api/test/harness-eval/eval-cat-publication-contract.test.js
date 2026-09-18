import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { evalDomainPublishInstructions } from '../../dist/infrastructure/harness-eval/eval-cat-invocation.js';

/**
 * F257: verdict publication is a durable artifact write, not a Git writeback.
 * `publish-verdict.ts` no longer creates a branch, a commit or a pull request, so
 * no domain may keep instructing its eval cat to chase one. Sampling a few domains
 * is what let nine footers drift out of sync with the implementation — this guard
 * asserts the whole table.
 */
const GIT_PUBLICATION_PROSE = [
  // `creates?` does not match `created`, which is how "evidence branch or PR is
  // created" survived a sweep meant to be total. Match the verb in every tense and in
  // either order relative to the noun, but keep them in one clause: a bare /branch/
  // also hits eval:sop's `gitState ({branch, ahead, behind, clean})` trace field,
  // which describes input data rather than instructing anyone to publish.
  /creat(e|es|ed|ing)\b[^.]{0,40}\b(branch|PR|pull request|commit)\b/i,
  /\b(branch|PR|pull request|commit)\b[^.]{0,40}\bcreat(e|es|ed|ing)\b/i,
  /opens? (a )?PR\b/i,
  /pull request/i,
  /PR URL/i,
  /commit SHA/i,
  /verdict\/auto\//i,
  /gh pr (create|merge)/i,
  /self-merge/i,
  /--delete-branch/i,
  /\bverdict PR\b/i,
  /\bevidence PR\b/i,
];

/**
 * The only sentences allowed to name Git publication, because they exist to deny it.
 * They are stripped before the scan above runs, so the scan can stay deliberately broad:
 * any OTHER mention of a branch/PR is a finding. The same constant is asserted present
 * below, so a domain cannot buy the exemption without actually stating the truth.
 */
const NON_GIT_DISCLAIMERS = [
  'It does not create a branch, a commit, or a pull request.',
  'The MCP tool returns an artifact reference (`artifactId` + `artifactUrl`), not a branch, commit or pull request.',
];

const withoutDisclaimers = (text) => NON_GIT_DISCLAIMERS.reduce((acc, sentence) => acc.split(sentence).join(''), text);

/** Explicit ID set — a shrinking table must fail loudly, not silently pass. */
const WIRED_PUBLISH_DOMAINS = [
  'eval:a2a',
  'eval:anchor-first',
  'eval:capability-wakeup',
  'eval:design-gate',
  'eval:freshness',
  'eval:friction',
  'eval:harness-ledger',
  'eval:memory',
  'eval:qc',
  'eval:sop',
  'eval:task-outcome',
  'eval:trajectory-inspector',
];

describe('F257 eval-cat publication contract', () => {
  it('censuses exactly the wired publish domains', () => {
    const ids = evalDomainPublishInstructions()
      .map((entry) => entry.domainId)
      .sort();
    assert.deepEqual(ids, [...WIRED_PUBLISH_DOMAINS].sort());
  });

  it('never instructs any domain to publish a verdict through Git', () => {
    const offenders = [];
    for (const { domainId, instructions } of evalDomainPublishInstructions()) {
      const scanned = withoutDisclaimers(instructions);
      for (const pattern of GIT_PUBLICATION_PROSE) {
        const hit = scanned.match(pattern);
        if (hit) offenders.push(`${domainId}: ${pattern} matched ${JSON.stringify(hit[0])}`);
      }
    }
    assert.deepEqual(offenders, [], `Git-publication prose survived:\n${offenders.join('\n')}`);
  });

  it('tells every domain what publish actually returns', () => {
    // Without this the scan above would also pass on an empty string.
    for (const { domainId, instructions } of evalDomainPublishInstructions()) {
      assert.match(instructions, /artifactId/, `${domainId} omits the artifact reference`);
      assert.match(instructions, /artifactUrl/, `${domainId} omits the artifact URL`);
      assert.ok(
        NON_GIT_DISCLAIMERS.some((sentence) => instructions.includes(sentence)),
        `${domainId} never states that publishing creates no branch/commit/PR`,
      );
    }
  });

  it('keeps the guard discriminating against the exact prose it replaced', () => {
    const retired =
      'The MCP tool creates branch `verdict/auto/{domainSlug}/{verdictId}` + commits + opens PR. Returns commit SHA + PR URL.';
    assert.ok(
      GIT_PUBLICATION_PROSE.some((pattern) => pattern.test(withoutDisclaimers(retired))),
      'guard would not have caught the footer it was written for',
    );

    // 砚砚 review: this exact sentence sat in the shared packet prose that every
    // domain inherits, and the guard was green because `creates?` never matches
    // `created`. Pin it so the blind spot cannot reopen.
    const inheritedRetired = 'unknown refs fail before any evidence branch or PR is created';
    assert.ok(
      GIT_PUBLICATION_PROSE.some((pattern) => pattern.test(withoutDisclaimers(inheritedRetired))),
      'guard must catch Git publication stated in the past tense',
    );

    // design-gate's footer was worded differently, which is exactly why the
    // nine-way textual sweep missed it and this table-wide guard did not.
    const designGateRetired =
      'The MCP tool creates the existing isolated evidence branch and PR. Do not write or push verdict artifacts directly.';
    assert.ok(
      GIT_PUBLICATION_PROSE.some((pattern) => pattern.test(withoutDisclaimers(designGateRetired))),
      'guard must catch differently-worded Git publication prose, not just the common footer',
    );
  });
});
