import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * F192 OQ-21 shared test fixtures — extracted from
 * `eval-manual-trigger-handlers.test.js` per cloud codex R6 P1 (350-line limit).
 *
 * Registers ALL 5 eval domains so 501 "unsupported_generator" tests can
 * distinguish "domain not in registry" (400) from "registered but no generator"
 * (501). Path-traversal + slug + happy tests can rely on the same fixtures.
 */
export function setupHarnessFeedback() {
  const root = mkdtempSync(join(tmpdir(), 'f192-manual-trigger-'));
  mkdirSync(join(root, 'eval-domains'), { recursive: true });
  mkdirSync(join(root, 'verdicts'), { recursive: true });
  mkdirSync(join(root, 'bundles'), { recursive: true });
  mkdirSync(join(root, 'snapshots'), { recursive: true });
  mkdirSync(join(root, 'attributions'), { recursive: true });

  const write = (name, contents) => writeFileSync(join(root, 'eval-domains', name), contents);

  // Compact YAML builder — domain config shape is identical across the 5 domains
  // so we factor out the boilerplate to keep this file under the line limit.
  const yamlFor = ({
    domainId,
    displayName,
    threadId,
    catId,
    model,
    frequency,
    sourceAdapter,
    sourceRefsKind,
    featureId,
  }) => `domainId: ${domainId}
displayName: ${displayName}
systemThreadId: ${threadId}
evalCat:
  catId: ${catId}
  handle: '@${catId}'
  model: ${model}
frequency: ${frequency}
sourceAdapter: ${sourceAdapter}
sourceRefsKind: ${sourceRefsKind}
threadPolicy:
  role: working-home
  stateSot: registry
  allowedContent:
    - longitudinal-analysis
    - verdict-discussion
    - handoff-drafts
legacyScheduledTaskIds: []
handoffTargetResolver:
  featureId: ${featureId}
  ownerCatId: opus-47
  threadLookup: feature-thread
sla:
  acknowledgeHours: 24
  reevalWithinHours: 72
fixtures: []
`;

  write(
    'eval-a2a.yaml',
    yamlFor({
      domainId: 'eval:a2a',
      displayName: 'A2A Harness Eval',
      threadId: 'thread_eval_a2a',
      catId: 'codex',
      model: 'gpt-5.5',
      frequency: 'daily',
      sourceAdapter: 'f167-runtime-eval',
      sourceRefsKind: 'a2a-snapshot-attribution',
      featureId: 'F167',
    }),
  );
  write(
    'eval-memory.yaml',
    yamlFor({
      domainId: 'eval:memory',
      displayName: 'Memory Harness Eval',
      threadId: 'thread_eval_memory',
      catId: 'opus-47',
      model: 'claude-opus-4-7',
      frequency: 'daily',
      sourceAdapter: 'f200-f188-memory-eval',
      sourceRefsKind: 'memory-recall-snapshot',
      featureId: 'F200',
    }),
  );
  write(
    'eval-sop.yaml',
    yamlFor({
      domainId: 'eval:sop',
      displayName: 'SOP Harness Eval',
      threadId: 'thread_eval_sop',
      catId: 'codex',
      model: 'gpt-5.5',
      frequency: 'weekly',
      sourceAdapter: 'sop-trace-eval',
      sourceRefsKind: 'sop-trace-eval',
      featureId: 'F203',
    }),
  );
  write(
    'eval-capability-wakeup.yaml',
    yamlFor({
      domainId: 'eval:capability-wakeup',
      displayName: 'Capability Wakeup Eval',
      threadId: 'thread_eval_capability_wakeup',
      catId: 'opus-47',
      model: 'claude-opus-4-7',
      frequency: 'weekly',
      sourceAdapter: 'capability-wakeup-eval',
      sourceRefsKind: 'capability-wakeup-trial-window',
      featureId: 'F203',
    }),
  );
  write(
    'eval-task-outcome.yaml',
    yamlFor({
      domainId: 'eval:task-outcome',
      displayName: 'Task Outcome Eval',
      threadId: 'thread_eval_task_outcome',
      catId: 'opus-47',
      model: 'claude-opus-4-7',
      frequency: 'daily',
      sourceAdapter: 'task-outcome-eval',
      sourceRefsKind: 'task-outcome-snapshot',
      featureId: 'F192',
    }),
  );

  return root;
}

/**
 * Write raw snapshot + attribution YAMLs to the production-convention
 * subdirectories (`<root>/snapshots/` and `<root>/attributions/`).
 * Returns BASENAMES — the API/handler accepts only basenames and resolves
 * them server-side under the allowlist directories (砚砚 R1 P1 security fix).
 */
export function setupRawArtifacts(root, dateStr = '2026-06-04') {
  const snapshotName = `${dateStr}-F167-eval.yaml`;
  const attributionName = `${dateStr}-F167-attribution.yaml`;

  writeFileSync(
    join(root, 'snapshots', snapshotName),
    `---
doc_kind: harness-feedback
feedback_type: eval-snapshot
feature_id: F167
generated_at: "${dateStr}T13:00:00.000Z"
---

# F167 Runtime Eval Snapshot — ${dateStr}

window:
  start_ms: 1779430000000
  end_ms: 1779516400000
  duration_hours: 24

components:
  - id: C1
    name: "routing contract"
    confidence: medium
    activation_counts:
      c1.route_seen: 12
    friction_counts:
      {}
  - id: C2
    name: "forced-pass guard"
    confidence: medium
    activation_counts:
      c2.verdict_hint_emitted: 20
    friction_counts:
      c2.verdict_without_pass_count: 9
`,
  );

  writeFileSync(
    join(root, 'attributions', attributionName),
    `---
doc_kind: harness-feedback
feedback_type: attribution
feature_id: F167
eval_snapshot_id: "eval-F167-${dateStr}"
generated_at: "${dateStr}T13:01:00.000Z"
---

# F167 Attribution Report — ${dateStr}

finding_count: 1

findings:
  - id: AR-${dateStr}-001
    related_feature: F167
    friction_signal:
      type: c2.verdict_without_pass_count
      severity: medium
      confidence: 0.7
    attribution:
      primary_layer: harness_misfit
      pipeline_or_human: pipeline
      evidence:
        - type: counter
          anchor: "C2/c2.verdict_without_pass_count"
          excerpt: "c2.verdict_without_pass_count=9 exceeds threshold"
    proposed_action:
      - action: harness-tune
        target: "C2"
        rationale: "forced-pass hint rate is high"
    fingerprint: "c2.verdict_without_pass_count::C2/c2.verdict_without_pass_count"
    status: open
`,
  );

  return { snapshotName, attributionName };
}
