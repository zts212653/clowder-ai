/**
 * Shared fixtures and helpers for eval-domain-nday tests.
 * Split from eval-domain-nday.test.js (cloud R4 P1: file-size hard limit 350 lines).
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const DAY_MS = 24 * 60 * 60 * 1000;

/** Stub domain for gate tests — domainId need NOT be registered in buildEvalCatInvocation. */
export const FIXTURE_3D_YAML = `
domainId: eval:test-friction
displayName: Test Friction Domain
systemThreadId: thread_test_friction
evalCat:
  catId: gpt52
  handle: "@gpt52"
  model: gpt-5.4
frequency: every-3d
sourceAdapter: f245-friction-rollup
sourceRefsKind: friction-rollup-snapshot
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent:
    - longitudinal-analysis
    - verdict-discussion
    - handoff-drafts
legacyScheduledTaskIds: []
handoffTargetResolver:
  featureId: F245
  ownerCatId: opus-47
  threadLookup: feature-thread
sla:
  acknowledgeHours: 48
  reevalWithinHours: 168
enabled: true
`.trim();

export const FIXTURE_7D_YAML = `
domainId: eval:test-sop
displayName: Test Sop Domain
systemThreadId: thread_test_sop
evalCat:
  catId: gpt52
  handle: "@gpt52"
  model: gpt-5.4
frequency: every-7d
sourceAdapter: sop-trace-rollup
sourceRefsKind: sop-trace-eval
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent:
    - longitudinal-analysis
    - verdict-discussion
    - handoff-drafts
legacyScheduledTaskIds: []
handoffTargetResolver:
  featureId: F192
  ownerCatId: opus-47
  threadLookup: feature-thread
sla:
  acknowledgeHours: 48
  reevalWithinHours: 168
enabled: true
`.trim();

/**
 * Execute tests need a domain with registered instructions (buildEvalCatInvocation
 * is fail-closed for unknown domainIds). eval:friction IS registered — use it.
 */
export const FIXTURE_FRICTION_3D_YAML = `
domainId: eval:friction
displayName: Friction Signal Eval
systemThreadId: thread_eval_friction
evalCat:
  catId: gpt52
  handle: "@gpt52"
  model: gpt-5.4
frequency: every-3d
sourceAdapter: f245-friction-rollup
sourceRefsKind: friction-rollup-snapshot
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent:
    - longitudinal-analysis
    - verdict-discussion
    - handoff-drafts
legacyScheduledTaskIds: []
handoffTargetResolver:
  featureId: F245
  ownerCatId: opus-47
  threadLookup: feature-thread
sla:
  acknowledgeHours: 48
  reevalWithinHours: 168
enabled: true
`.trim();

/**
 * Cloud R1 P2: fixture with a legacyScheduledTaskId to test the legacy-task double-trigger gate.
 * The domainId does NOT need to be registered in buildEvalCatInvocation because we only
 * test gate() admission (not execute()); gate() doesn't call buildEvalCatInvocation.
 */
export const FIXTURE_3D_WITH_LEGACY_YAML = `
domainId: eval:test-friction-legacy
displayName: Test Friction With Legacy Task
systemThreadId: thread_test_friction_legacy
evalCat:
  catId: gpt52
  handle: "@gpt52"
  model: gpt-5.4
frequency: every-3d
sourceAdapter: f245-friction-rollup
sourceRefsKind: friction-rollup-snapshot
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent:
    - longitudinal-analysis
legacyScheduledTaskIds:
  - legacy-fit-digest
handoffTargetResolver:
  featureId: F245
  ownerCatId: opus-47
  threadLookup: feature-thread
sla:
  acknowledgeHours: 48
  reevalWithinHours: 168
enabled: true
`.trim();

/** Create a temp harnessFeedbackRoot with given YAML fixtures. */
export function makeTempRoot(...yamlFixtures) {
  const tmp = mkdtempSync(join(tmpdir(), 'eval-nday-test-'));
  const domainsDir = join(tmp, 'eval-domains');
  mkdirSync(domainsDir);
  for (let i = 0; i < yamlFixtures.length; i++) {
    writeFileSync(join(domainsDir, `fixture-${i}.yaml`), yamlFixtures[i]);
  }
  return tmp;
}

/** Minimal ioredis-compatible mock. keyPrefix NOT applied (tests use raw keys). */
export function makeRedis(initStore = {}) {
  const store = new Map(Object.entries(initStore));
  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
      return 'OK';
    },
    _store: store,
  };
}
