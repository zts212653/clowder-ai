import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildEvalCatInvocation } from '../../dist/infrastructure/harness-eval/eval-cat-invocation.js';

/**
 * F192 Phase H AC-H4: eval cat DOMAIN_INSTRUCTIONS upgraded to point cats to
 * `cat_cafe_publish_verdict` MCP tool (replaces abandoned PR #2091 'git push'
 * 教学 which violated §5 rule #2). Tests assert all 5 domain instructions
 * carry the publish-verdict directive + 9-field packet schema reference + NOT
 * contain abandoned git-push anti-pattern.
 */
const TEST_DOMAIN_BASE = {
  displayName: 'Test Domain',
  systemThreadId: 'thread_test',
  evalCat: { catId: 'codex', handle: '@codex', model: 'gpt-5.5' },
  frequency: /** @type {const} */ ('daily'),
  sourceRefsKind: /** @type {const} */ ('a2a-snapshot-attribution'),
  threadPolicy: {
    role: /** @type {const} */ ('working-home'),
    stateSot: /** @type {const} */ ('registry'),
    allowedContent: /** @type {const} */ (['longitudinal-analysis', 'verdict-discussion', 'handoff-drafts']),
  },
  legacyScheduledTaskIds: [],
  handoffTargetResolver: {
    featureId: 'F167',
    ownerCatId: 'opus-47',
    threadLookup: /** @type {const} */ ('feature-thread'),
  },
  sla: { acknowledgeHours: 24, reevalWithinHours: 72 },
  fixtures: [],
};

const SOURCE_ADAPTER_FOR = {
  'eval:a2a': 'f167-runtime-eval',
  'eval:memory': 'f200-f188-memory-eval',
  'eval:sop': 'sop-trace-eval',
  'eval:capability-wakeup': 'capability-wakeup-eval',
  'eval:task-outcome': 'task-outcome-eval',
};

const SOURCE_REFS_KIND_FOR = {
  'eval:a2a': 'a2a-snapshot-attribution',
  'eval:memory': 'memory-recall-snapshot',
  'eval:sop': 'sop-trace-eval',
  'eval:capability-wakeup': 'capability-wakeup-trial-window',
  'eval:task-outcome': 'task-outcome-snapshot',
};

describe('Phase H AC-H4: eval cat instructions point to publish_verdict MCP tool', () => {
  // 砚砚 R2 P1 cloud: eval:a2a only has wired generator in v1 — instructions
  // for other domains do NOT mention MCP tool (would cause cat → 501 loop).
  it('eval:a2a instruction references cat_cafe_publish_verdict MCP tool', () => {
    const packet = buildEvalCatInvocation({
      domain: { ...TEST_DOMAIN_BASE, domainId: 'eval:a2a', sourceAdapter: 'f167-runtime-eval' },
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'not_checked' },
    });
    assert.match(packet.instructions, /cat_cafe_publish_verdict/);
    assert.match(packet.instructions, /VerdictHandoffPacket/);
  });

  it('eval:a2a instruction lists all 11 always-required packet fields (砚砚 R1 P2 #1)', () => {
    // 11 always-required + 1 conditional (governance for delete_sunset) = 12 total
    const requiredFields = [
      'id',
      'domainId',
      'createdAt',
      'phenomenon',
      'harnessUnderEval',
      'evidencePacket',
      'dailyTrend',
      'rootCauseHypothesis',
      'verdict',
      'ownerAsk',
      'acceptanceReevalPlan',
      'counterarguments',
    ];
    const packet = buildEvalCatInvocation({
      domain: { ...TEST_DOMAIN_BASE, domainId: 'eval:a2a', sourceAdapter: 'f167-runtime-eval' },
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'not_checked' },
    });
    for (const field of requiredFields) {
      assert.match(packet.instructions, new RegExp(`\\*\\*${field}\\*\\*`), `must list ${field} as required`);
    }
  });

  it('eval:a2a instruction explicitly forbids abandoned git-push anti-pattern (§5 rule #2)', () => {
    const packet = buildEvalCatInvocation({
      domain: { ...TEST_DOMAIN_BASE, domainId: 'eval:a2a', sourceAdapter: 'f167-runtime-eval' },
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'not_checked' },
    });
    assert.match(packet.instructions, /DO NOT.*git push/i, 'must forbid git push');
    assert.match(packet.instructions, /Use the MCP tool/, 'must redirect to MCP tool');
  });

  it('instructions mention branch + commit + PR shape (so cat understands tool side-effects)', () => {
    const packet = buildEvalCatInvocation({
      domain: { ...TEST_DOMAIN_BASE, domainId: 'eval:a2a', sourceAdapter: 'f167-runtime-eval' },
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'not_checked' },
    });
    assert.match(packet.instructions, /verdict\/auto\/\{domainSlug\}\/\{verdictId\}/, 'branch name pattern');
    assert.match(packet.instructions, /commit SHA \+ PR URL/, 'response shape');
  });

  it('instructions reference sourceRefs (砚砚 R1 P1 #2 + R2 P2: tool NEVER 造 evidence + basenames only)', () => {
    const packet = buildEvalCatInvocation({
      domain: { ...TEST_DOMAIN_BASE, domainId: 'eval:a2a', sourceAdapter: 'f167-runtime-eval' },
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'not_checked' },
    });
    assert.match(packet.instructions, /sourceRefs/, 'instructions must mention sourceRefs');
    assert.match(packet.instructions, /snapshotName/, 'instructions must list snapshotName (basename, not path)');
    assert.match(packet.instructions, /attributionName/, 'instructions must list attributionName (basename, not path)');
    assert.match(packet.instructions, /BASENAMES|basenames/i, 'must emphasize basename-only');
    assert.match(packet.instructions, /NOT fabricate|will not fabricate|tool will NOT/i, 'forbid fabrication');
  });

  it('task-outcome base instruction keeps packet verdict 4-class and routes episode verdicts through sourceRefs', () => {
    const packet = buildEvalCatInvocation({
      domain: {
        ...TEST_DOMAIN_BASE,
        domainId: 'eval:task-outcome',
        sourceAdapter: 'task-outcome-eval',
        sourceRefsKind: 'task-outcome-snapshot',
      },
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'not_checked' },
    });
    assert.match(packet.instructions, /fix\/build\/keep_observe\/delete_sunset/i);
    assert.match(packet.instructions, /sourceRefs\.episodeVerdicts/i);
    assert.match(packet.instructions, /terminal episodes you actually reviewed/i);
    assert.doesNotMatch(packet.instructions, /writeback path is unfinished|do not assume it is queryable yet/i);
    assert.doesNotMatch(
      packet.instructions,
      /Verdict is categorical \(success\/corrected_success\/needs_investigation\/harness_fix_needed\/routing_failure\/taste_mismatch\/abandoned\)/,
      'task-outcome base instruction must not promise the old 7-class packet verdict contract',
    );
  });

  // All five domains now have wired generators and should see publish instructions.
  // Wired: eval:a2a + eval:capability-wakeup + eval:memory + eval:task-outcome + eval:sop.
  it('only wired domains get publish-verdict directive (wired domains only)', () => {
    for (const wiredDomain of ['eval:a2a', 'eval:capability-wakeup', 'eval:memory', 'eval:task-outcome', 'eval:sop']) {
      const packet = buildEvalCatInvocation({
        domain: {
          ...TEST_DOMAIN_BASE,
          domainId: wiredDomain,
          sourceAdapter: SOURCE_ADAPTER_FOR[wiredDomain],
          sourceRefsKind: SOURCE_REFS_KIND_FOR[wiredDomain],
        },
        trendRefs: [],
        verdictRefs: [],
        legacyCleanup: { status: 'not_checked' },
      });
      assert.match(
        packet.instructions,
        /cat_cafe_publish_verdict/,
        `${wiredDomain} must have publish path (generator wired)`,
      );
    }

    // Domain-specific sourceRefs docs:
    const a2a = buildEvalCatInvocation({
      domain: { ...TEST_DOMAIN_BASE, domainId: 'eval:a2a', sourceAdapter: 'f167-runtime-eval' },
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'not_checked' },
    });
    assert.match(a2a.instructions, /snapshotName.*attributionName/s, 'a2a sourceRefs doc');
    assert.doesNotMatch(a2a.instructions, /capability-wakeup-trial-window/, 'a2a does NOT mention cw selector');
    assert.doesNotMatch(a2a.instructions, /memory-recall-snapshot/, 'a2a does NOT mention memory selector');

    const cw = buildEvalCatInvocation({
      domain: {
        ...TEST_DOMAIN_BASE,
        domainId: 'eval:capability-wakeup',
        sourceAdapter: 'capability-wakeup-eval',
        sourceRefsKind: 'capability-wakeup-trial-window',
      },
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'not_checked' },
    });
    assert.match(cw.instructions, /capability-wakeup-trial-window/, 'cw selector kind');
    assert.match(cw.instructions, /windowStartMs.*windowEndMs/s, 'cw window doc');
    assert.match(cw.instructions, /sessionIds.*OPTIONAL/s, 'cw sessionIds optional narrow');
    assert.match(
      cw.instructions,
      /Omit it for the default unbiased runtime-session window scan/s,
      'cw default scan doc',
    );
    assert.doesNotMatch(cw.instructions, /snapshotName.*attributionName/s, 'cw does NOT mention a2a refs');
    assert.doesNotMatch(cw.instructions, /memory-recall-snapshot/, 'cw does NOT mention memory selector');

    const mem = buildEvalCatInvocation({
      domain: {
        ...TEST_DOMAIN_BASE,
        domainId: 'eval:memory',
        sourceAdapter: 'f200-f188-memory-eval',
        sourceRefsKind: 'memory-recall-snapshot',
      },
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'not_checked' },
    });
    assert.match(mem.instructions, /memory-recall-snapshot/, 'memory selector kind');
    assert.match(mem.instructions, /windowDays/, 'memory windowDays field');
    assert.match(mem.instructions, /catId/, 'memory catId optional filter');
    assert.match(mem.instructions, /toolName/, 'memory toolName optional filter');
    assert.doesNotMatch(mem.instructions, /snapshotName.*attributionName/s, 'memory does NOT mention a2a refs');
    assert.doesNotMatch(mem.instructions, /capability-wakeup-trial-window/, 'memory does NOT mention cw selector kind');

    const taskOutcome = buildEvalCatInvocation({
      domain: {
        ...TEST_DOMAIN_BASE,
        domainId: 'eval:task-outcome',
        sourceAdapter: 'task-outcome-eval',
        sourceRefsKind: 'task-outcome-snapshot',
      },
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'not_checked' },
    });
    assert.match(taskOutcome.instructions, /task-outcome-snapshot/, 'task-outcome selector kind');
    assert.match(taskOutcome.instructions, /windowStartMs.*windowEndMs/s, 'task-outcome window doc');
    assert.doesNotMatch(taskOutcome.instructions, /sessionIds.*REQUIRED/s, 'task-outcome does not require sessionIds');
    assert.doesNotMatch(
      taskOutcome.instructions,
      /snapshotName.*attributionName/s,
      'task-outcome does NOT mention a2a refs',
    );

    const sop = buildEvalCatInvocation({
      domain: {
        ...TEST_DOMAIN_BASE,
        domainId: 'eval:sop',
        sourceAdapter: 'sop-trace-eval',
        sourceRefsKind: 'sop-trace-eval',
      },
      trendRefs: [],
      verdictRefs: [],
      legacyCleanup: { status: 'not_checked' },
    });
    assert.match(sop.instructions, /sop-trace-eval/, 'sop selector kind');
    assert.match(sop.instructions, /sopDefinitionId/, 'sop sopDefinitionId field');
    assert.match(sop.instructions, /trace/, 'sop trace field');
    assert.doesNotMatch(sop.instructions, /snapshotName.*attributionName/s, 'sop does NOT mention a2a refs');
    assert.doesNotMatch(sop.instructions, /capability-wakeup-trial-window/, 'sop does NOT mention cw selector');
    assert.doesNotMatch(sop.instructions, /memory-recall-snapshot/, 'sop does NOT mention memory selector');
  });

  // memory wire-up (砚砚 R1 P1 same gating as cw): wiredPublishDomains gates
  // memory publish instructions on actual runtime support. memoryServices.markerQueue
  // bootstrap is unconditional in production but the gate must still respect explicit
  // wired-set so tests + edge configurations don't see 501-bound publish instructions.
  it('omits memory publish instructions when wiredPublishDomains excludes eval:memory', () => {
    const memUnwired = buildEvalCatInvocation(
      {
        domain: {
          ...TEST_DOMAIN_BASE,
          domainId: 'eval:memory',
          sourceAdapter: 'f200-f188-memory-eval',
          sourceRefsKind: 'memory-recall-snapshot',
        },
        trendRefs: [],
        verdictRefs: [],
        legacyCleanup: { status: 'not_checked' },
      },
      { wiredPublishDomains: new Set(['eval:a2a']) }, // memory NOT wired
    );
    assert.doesNotMatch(
      memUnwired.instructions,
      /cat_cafe_publish_verdict/,
      'memory without runtime wire must NOT see publish path (would waste run on 501)',
    );
    assert.doesNotMatch(memUnwired.instructions, /memory-recall-snapshot/, 'memory selector docs gated too');

    // Sanity: when memory IS wired, publish instructions + selector docs appear.
    const memWired = buildEvalCatInvocation(
      {
        domain: {
          ...TEST_DOMAIN_BASE,
          domainId: 'eval:memory',
          sourceAdapter: 'f200-f188-memory-eval',
          sourceRefsKind: 'memory-recall-snapshot',
        },
        trendRefs: [],
        verdictRefs: [],
        legacyCleanup: { status: 'not_checked' },
      },
      { wiredPublishDomains: new Set(['eval:a2a', 'eval:memory']) },
    );
    assert.match(memWired.instructions, /cat_cafe_publish_verdict/, 'memory with runtime wire must see publish path');
    assert.match(memWired.instructions, /memory-recall-snapshot/, 'memory with runtime wire must see selector docs');
  });

  // cloud R5 P2 (PR-2): wiredPublishDomains gates publish instructions on actual
  // runtime support — cw publish instructions must be omitted when bootstrap skipped
  // the cw generator wire (e.g. Redis-backed ports unavailable). Without this gating,
  // cw cat sees publish instructions and wastes a run producing a packet that
  // returns 501 from handler.
  it('omits publish instructions when wiredPublishDomains excludes the domain (cloud R5 P2)', () => {
    // cw is in known-wireable BY_DOMAIN map, BUT runtime didn't wire it (Redis missing).
    const cwUnwired = buildEvalCatInvocation(
      {
        domain: {
          ...TEST_DOMAIN_BASE,
          domainId: 'eval:capability-wakeup',
          sourceAdapter: 'capability-wakeup-eval',
          sourceRefsKind: 'capability-wakeup-trial-window',
        },
        trendRefs: [],
        verdictRefs: [],
        legacyCleanup: { status: 'not_checked' },
      },
      { wiredPublishDomains: new Set(['eval:a2a']) }, // cw NOT wired
    );
    assert.doesNotMatch(
      cwUnwired.instructions,
      /cat_cafe_publish_verdict/,
      'cw without runtime wire must NOT see publish path (would waste run on 501)',
    );

    // Sanity: when cw IS wired, publish instructions appear.
    const cwWired = buildEvalCatInvocation(
      {
        domain: {
          ...TEST_DOMAIN_BASE,
          domainId: 'eval:capability-wakeup',
          sourceAdapter: 'capability-wakeup-eval',
          sourceRefsKind: 'capability-wakeup-trial-window',
        },
        trendRefs: [],
        verdictRefs: [],
        legacyCleanup: { status: 'not_checked' },
      },
      { wiredPublishDomains: new Set(['eval:a2a', 'eval:capability-wakeup']) },
    );
    assert.match(cwWired.instructions, /cat_cafe_publish_verdict/, 'cw with runtime wire must see publish path');

    const taskOutcomeUnwired = buildEvalCatInvocation(
      {
        domain: {
          ...TEST_DOMAIN_BASE,
          domainId: 'eval:task-outcome',
          sourceAdapter: 'task-outcome-eval',
          sourceRefsKind: 'task-outcome-snapshot',
        },
        trendRefs: [],
        verdictRefs: [],
        legacyCleanup: { status: 'not_checked' },
      },
      { wiredPublishDomains: new Set(['eval:a2a', 'eval:capability-wakeup']) },
    );
    assert.doesNotMatch(taskOutcomeUnwired.instructions, /cat_cafe_publish_verdict/);

    const taskOutcomeWired = buildEvalCatInvocation(
      {
        domain: {
          ...TEST_DOMAIN_BASE,
          domainId: 'eval:task-outcome',
          sourceAdapter: 'task-outcome-eval',
          sourceRefsKind: 'task-outcome-snapshot',
        },
        trendRefs: [],
        verdictRefs: [],
        legacyCleanup: { status: 'not_checked' },
      },
      { wiredPublishDomains: new Set(['eval:a2a', 'eval:capability-wakeup', 'eval:task-outcome']) },
    );
    assert.match(taskOutcomeWired.instructions, /cat_cafe_publish_verdict/);
  });
});
