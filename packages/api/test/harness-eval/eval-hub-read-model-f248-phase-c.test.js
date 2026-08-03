import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { resolveWorktreeIdByPath } from '../../dist/domains/workspace/workspace-security.js';
import { loadEvalHubSummary } from '../../dist/infrastructure/harness-eval/hub/eval-hub-read-model.js';

const repoHarnessFeedbackRoot = fileURLToPath(new URL('../../../../docs/harness-feedback', import.meta.url));
const FIXTURE_NOW_BEFORE_DEADLINE = new Date('2026-05-23T12:00:00.000Z');

describe('Eval Hub read model — F248 Phase C', () => {
  it('includes evalCatId and nextCronFireAt in domain summaries (#OQ-20)', () => {
    const summary = loadEvalHubSummary({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      now: FIXTURE_NOW_BEFORE_DEADLINE,
    });

    const a2aDomain = summary.domains.find((d) => d.domainId === 'eval:a2a');
    assert.ok(a2aDomain);
    assert.equal(a2aDomain.evalCatId, 'codex', 'domain summary must include evalCatId');
    assert.equal(
      a2aDomain.nextCronFireAt,
      '2026-05-24T03:00:00.000Z',
      'daily domain nextCronFireAt = next 03:00 UTC after now',
    );

    const memoryDomain = summary.domains.find((d) => d.domainId === 'eval:memory');
    assert.ok(memoryDomain);
    assert.equal(memoryDomain.evalCatId, 'opus-47');
    assert.equal(
      memoryDomain.nextCronFireAt,
      '2026-05-24T03:00:00.000Z',
      'no-verdict domain still gets nextCronFireAt',
    );

    const sopDomain = summary.domains.find((d) => d.domainId === 'eval:sop');
    assert.ok(sopDomain);
    assert.equal(sopDomain.enabled, true, 're-enabled sop domain must carry enabled=true');
    assert.equal(
      sopDomain.nextCronFireAt,
      '2026-05-24T03:00:00.000Z',
      're-enabled weekly sop domain nextCronFireAt = next Sunday 03:00 UTC',
    );

    const cwDomain = summary.domains.find((d) => d.domainId === 'eval:capability-wakeup');
    assert.ok(cwDomain);
    assert.equal(cwDomain.enabled, true, 'enabled weekly domain must carry enabled=true');
    assert.equal(
      cwDomain.nextCronFireAt,
      '2026-05-24T03:00:00.000Z',
      'enabled weekly domain nextCronFireAt = next Sunday 03:00 UTC',
    );
  });

  it('attaches enabled flag for ALL domains in summary (sunset visibility — F192 silent-fire fix)', () => {
    const summary = loadEvalHubSummary({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      now: FIXTURE_NOW_BEFORE_DEADLINE,
    });

    for (const d of summary.domains) {
      assert.equal(typeof d.enabled, 'boolean', `${d.domainId} must have boolean enabled field`);
    }

    const sopDomain = summary.domains.find((d) => d.domainId === 'eval:sop');
    assert.ok(sopDomain);
    assert.equal(sopDomain.enabled, true);
    assert.ok(sopDomain.nextCronFireAt, 're-enabled weekly domain must have nextCronFireAt');

    const a2aDomain = summary.domains.find((d) => d.domainId === 'eval:a2a');
    assert.ok(a2aDomain);
    assert.equal(a2aDomain.enabled, true);
    assert.ok(a2aDomain.nextCronFireAt, 'enabled domain must have nextCronFireAt');
  });

  it('fails closed when a live verdict points at a missing evidence bundle', () => {
    const harnessFeedbackRoot = mkdtempSync(join(tmpdir(), 'f192-eval-hub-'));
    const verdictPath = join(harnessFeedbackRoot, 'verdicts', '2026-05-24-bad-live-verdict.md');
    mkdirSync(dirname(verdictPath), { recursive: true });
    writeFileSync(
      verdictPath,
      `---
feature_ids: [F192, F167]
topics: [harness-eval, eval-a2a, live-verdict]
doc_kind: harness-feedback
feedback_type: live-verdict
domain_id: eval:a2a
packet_id: vhp_bad
source_snapshot: "snapshot:bundle/2026-05-24-bad-live-verdict/snapshot"
---

# Live Verdict - 2026-05-24-bad-live-verdict

- Verdict: \`keep_observe\`
- Phenomenon: Missing bundle should fail closed
- Harness: F167/C1 (hold_ball (MCP tool))
- Owner ask: No action required; keep observing.
- Re-eval: next eval remains clean at 2026-05-27T00:00:00.000Z

Evidence:
- snapshot:bundle/2026-05-24-bad-live-verdict/snapshot
- attribution:bundle/2026-05-24-bad-live-verdict/eval-F167-2026-05-24:no-finding
- metric:c1.zombie_hold_count
`,
      'utf8',
    );

    assert.throws(
      () => loadEvalHubSummary({ harnessFeedbackRoot }),
      /failed to resolve evidence bundle for 2026-05-24-bad-live-verdict/,
    );
  });

  it('includes repoWorktreeId derived from harnessFeedbackRoot grandparent (F248-C)', () => {
    const summary = loadEvalHubSummary({
      harnessFeedbackRoot: repoHarnessFeedbackRoot,
      now: FIXTURE_NOW_BEFORE_DEADLINE,
    });

    assert.equal(
      summary.repoProjectPath,
      dirname(dirname(repoHarnessFeedbackRoot)),
      'summary must expose the repo project path for cross-project workspace navigation',
    );
    assert.ok(summary.repoWorktreeId, 'summary must include repoWorktreeId');
    const expectedId = dirname(dirname(repoHarnessFeedbackRoot))
      .split('/')
      .pop()
      .replace(/[^a-zA-Z0-9_-]/g, '_');
    assert.equal(
      summary.repoWorktreeId,
      expectedId,
      `repoWorktreeId must match basename of repo root (expected "${expectedId}")`,
    );
  });

  it('returns the de-duplicated repoWorktreeId for duplicate-basename worktrees', async () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'f248-read-model-worktreeid-'));
    const mainRoot = resolve(tempRoot, 'primary', 'cat-cafe');
    const twinRoot = resolve(tempRoot, 'secondary', 'cat-cafe');
    mkdirSync(mainRoot, { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: mainRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'F248 Test'], { cwd: mainRoot, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'f248@example.com'], { cwd: mainRoot, stdio: 'ignore' });
    mkdirSync(join(mainRoot, 'seed'), { recursive: true });
    execFileSync('git', ['add', '.'], { cwd: mainRoot, stdio: 'ignore' });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'seed'], { cwd: mainRoot, stdio: 'ignore' });
    execFileSync('git', ['worktree', 'add', twinRoot, '-b', 'feat/twin'], { cwd: mainRoot, stdio: 'ignore' });

    const harnessFeedbackRoot = join(twinRoot, 'docs', 'harness-feedback');
    cpSync(repoHarnessFeedbackRoot, harnessFeedbackRoot, { recursive: true });

    const summary = loadEvalHubSummary({
      harnessFeedbackRoot,
      now: FIXTURE_NOW_BEFORE_DEADLINE,
    });

    assert.equal(summary.repoProjectPath, twinRoot);
    assert.equal(summary.repoWorktreeId, await resolveWorktreeIdByPath(twinRoot, twinRoot));
  });

  it('derives repoWorktreeId correctly from a temp harness root (F248-C)', () => {
    const tempRoot = mkdtempSync(join(tmpdir(), 'f248-c-worktreeid-'));
    const repoRoot = join(tempRoot, 'repo');
    const harnessFeedbackRoot = join(repoRoot, 'docs', 'harness-feedback');
    const domainsDir = join(harnessFeedbackRoot, 'eval-domains');
    const verdictsDir = join(harnessFeedbackRoot, 'verdicts');
    mkdirSync(domainsDir, { recursive: true });
    mkdirSync(verdictsDir, { recursive: true });

    writeFileSync(
      join(domainsDir, 'eval-a2a.yaml'),
      readFileSync(join(repoHarnessFeedbackRoot, 'eval-domains', 'eval-a2a.yaml'), 'utf8'),
    );

    const summary = loadEvalHubSummary({
      harnessFeedbackRoot,
      now: FIXTURE_NOW_BEFORE_DEADLINE,
    });

    assert.equal(summary.repoProjectPath, repoRoot, 'repoProjectPath must be the grandparent repo root');
    assert.ok(summary.repoWorktreeId, 'repoWorktreeId must be present even with zero verdicts');
    const expected = repoRoot
      .split('/')
      .pop()
      .replace(/[^a-zA-Z0-9_-]/g, '_');
    assert.equal(summary.repoWorktreeId, expected);
  });
});
