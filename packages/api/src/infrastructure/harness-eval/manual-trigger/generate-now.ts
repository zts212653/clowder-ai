import { existsSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve } from 'node:path';
import { generateA2aLiveVerdict } from '../a2a/eval-a2a-live-verdict.js';
import { loadDomains, loadEvalHubSummary } from '../hub/eval-hub-read-model.js';
import type { HandlerError, ManualTriggerDeps } from './types.js';

// Cloud codex R10 P1 + 砚砚收敛 A: length limits for user-supplied fields.
// verdictId becomes a filename (`<id>.md`) + directory (`bundles/<id>/`);
// artifact basenames resolve to allowlist dir entries. Conservative POSIX
// basename limit (255) for artifact names; verdictId tighter to keep slugs
// human-readable + URL-safe in Hub UI.
const MAX_VERDICT_ID_LEN = 128;
const MAX_ARTIFACT_NAME_LEN = 255;

export interface GenerateNowInput {
  domainId: string;
  userId: string;
  verdictId?: string;
  /**
   * Basename of the raw snapshot YAML inside `<harnessFeedbackRoot>/snapshots/`.
   * MUST be a plain filename — no path separators, no `.` / `..`. Resolved
   * server-side under allowlist directory before any filesystem read
   * (砚砚 R1 P1: never accept arbitrary paths from session API).
   */
  snapshotName?: string;
  /**
   * Basename of the raw attribution YAML inside `<harnessFeedbackRoot>/attributions/`.
   * Same allowlist constraints as `snapshotName`.
   */
  attributionName?: string;
}

export interface GenerateNowSuccess {
  ok: true;
  domainId: string;
  verdictId: string;
  verdictPath: string;
  bundleDir: string;
  hubRoundtrip: { ok: boolean; itemCount: number };
  note: string;
}

/**
 * Resolve a user-supplied raw artifact basename against an allowlist directory.
 *
 * Defense in depth:
 *  1. Reject empty / "." / ".." early.
 *  2. Reject any name where `basename(name) !== name` (catches `subdir/foo`,
 *     `../foo`, `/etc/passwd`, etc).
 *  3. After resolve+relative, ensure the path is still inside the allowed dir.
 */
function resolveSafeRawPath(
  allowedDir: string,
  name: string,
): { ok: true; path: string } | { ok: false; reason: string } {
  if (!name || name === '.' || name === '..') {
    return { ok: false, reason: 'must be a non-empty filename, not "." or ".."' };
  }
  if (basename(name) !== name) {
    return { ok: false, reason: 'must be a simple basename (no path separators)' };
  }
  const absoluteAllowed = resolve(allowedDir);
  const resolved = resolve(absoluteAllowed, name);
  const rel = relative(absoluteAllowed, resolved);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, reason: 'resolved path escapes allowlist directory' };
  }
  return { ok: true, path: resolved };
}

/**
 * F192 OQ-21: Manually generate a live verdict for eval:a2a using existing
 * `generateA2aLiveVerdict` (PR #1856). Writes verdict.md + bundle/ to
 * `docs/harness-feedback/` and verifies roundtrip through `loadEvalHubSummary()`.
 *
 * Unsupported domains (memory/sop/task-outcome/capability-wakeup) return 501
 * — NOT a stub `keep_observe`. 砚砚 directive: 低质量 keep_observe 比无报告更坏
 * (污染 Eval Hub 信任). Other domains gain generators in Path B+.
 *
 * Generator writes to working tree only. For permanent SOT, artifacts must be
 * committed via PR/merge-gate (砚砚: 未 commit ≠ 长期 SOT).
 */
export async function handleGenerateNow(
  deps: Pick<ManualTriggerDeps, 'harnessFeedbackRoot'>,
  input: GenerateNowInput,
): Promise<GenerateNowSuccess | HandlerError> {
  // 砚砚 R1 P2-a: validate domain via registry FIRST — unknown = 400, NOT 501.
  // Without this, typo'd domainIds get falsely labeled "unsupported_generator".
  const domains = loadDomains(deps.harnessFeedbackRoot);
  const domain = domains.get(input.domainId as Parameters<typeof domains.get>[0]);
  if (!domain) {
    return { status: 400, error: `Domain '${input.domainId}' not registered in eval-domains/` };
  }

  // Registered but no live-verdict generator wired in v1 → 501.
  // 砚砚 P1 (R0): NO stub. 低质量 keep_observe 污染 Eval Hub 信任.
  if (input.domainId !== 'eval:a2a') {
    return {
      status: 501,
      error: 'unsupported_generator',
      detail: `Domain '${input.domainId}' is registered but has no live-verdict generator wired. Only eval:a2a in v1 (F192 OQ-21). Other domains (memory/sop/capability-wakeup/task-outcome) gain generators in Path B+.`,
    };
  }

  // Cloud codex R3 P2: validate body field types BEFORE reaching basename()/resolve().
  // Non-strings would hit `node:path.basename()` → TypeError → Fastify 500.
  const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
  if (
    !isNonEmptyString(input.verdictId) ||
    !isNonEmptyString(input.snapshotName) ||
    !isNonEmptyString(input.attributionName)
  ) {
    return {
      status: 400,
      error: 'verdictId, snapshotName, attributionName must all be non-empty strings for eval:a2a generate-now',
    };
  }

  // Cloud codex R4 P2: validate verdictId slug format BEFORE calling generator.
  // Generator throws "verdictId must be a safe slug" for uppercase/underscores/
  // leading-hyphen — currently caught and returned as 500 ("Generator failed").
  // These are deterministic bad-requests, surface as 400 with the actual pattern.
  // Mirrors SAFE_VERDICT_ID_PATTERN in eval-a2a-live-verdict.ts.
  const SAFE_VERDICT_ID = /^[a-z0-9][a-z0-9-]*$/;
  if (!SAFE_VERDICT_ID.test(input.verdictId)) {
    return {
      status: 400,
      error: `verdictId must match safe slug pattern /^[a-z0-9][a-z0-9-]*$/ (lowercase alphanumeric + hyphens, no leading hyphen). Got: '${input.verdictId}'`,
    };
  }

  // 砚砚 R10 收敛 A: length limits — prevent DoS via huge inputs and keep
  // verdict files / bundle dirs within filesystem limits.
  if (input.verdictId.length > MAX_VERDICT_ID_LEN) {
    return {
      status: 400,
      error: `verdictId must be <= ${MAX_VERDICT_ID_LEN} chars (got ${input.verdictId.length})`,
    };
  }
  if (input.snapshotName.length > MAX_ARTIFACT_NAME_LEN) {
    return {
      status: 400,
      error: `snapshotName must be <= ${MAX_ARTIFACT_NAME_LEN} chars (got ${input.snapshotName.length})`,
    };
  }
  if (input.attributionName.length > MAX_ARTIFACT_NAME_LEN) {
    return {
      status: 400,
      error: `attributionName must be <= ${MAX_ARTIFACT_NAME_LEN} chars (got ${input.attributionName.length})`,
    };
  }

  // 砚砚 R1 P1 (security): resolve user-supplied basenames under allowlist directories
  // BEFORE calling generator. Previously the route accepted raw paths and forwarded
  // them to readFileSync — any authenticated session could read arbitrary local files.
  // Raw artifacts live in `<harnessFeedbackRoot>/snapshots/` + `/attributions/` per OQ-15.
  const snapshotsDir = resolve(deps.harnessFeedbackRoot, 'snapshots');
  const attributionsDir = resolve(deps.harnessFeedbackRoot, 'attributions');

  const snapshotResult = resolveSafeRawPath(snapshotsDir, input.snapshotName);
  if (!snapshotResult.ok) {
    return { status: 400, error: `snapshotName invalid: ${snapshotResult.reason}` };
  }

  const attributionResult = resolveSafeRawPath(attributionsDir, input.attributionName);
  if (!attributionResult.ok) {
    return { status: 400, error: `attributionName invalid: ${attributionResult.reason}` };
  }

  // Cloud codex R10 P1 + 砚砚收敛 A: idempotency guard — generator uses plain
  // writeFileSync on `verdicts/<id>.md` and `bundles/<id>/*.json` and would
  // silently overwrite existing Eval Hub evidence on duplicate verdictId.
  // This is evidence-chain data corruption, NOT a v1.5 polish. Reject with 409
  // BEFORE invoking the generator so prior verdict + bundle remain intact.
  const verdictPath = resolve(deps.harnessFeedbackRoot, 'verdicts', `${input.verdictId}.md`);
  const bundleDir = resolve(deps.harnessFeedbackRoot, 'bundles', input.verdictId);
  if (existsSync(verdictPath) || existsSync(bundleDir)) {
    return {
      status: 409,
      error: 'verdict_already_exists',
      detail: `verdictId '${input.verdictId}' already has a verdict file or bundle directory under docs/harness-feedback/. Overwriting existing Eval Hub evidence is forbidden (data integrity). Pick a different verdictId or delete the existing artifacts first.`,
    };
  }

  let artifact: ReturnType<typeof generateA2aLiveVerdict>;
  try {
    artifact = generateA2aLiveVerdict({
      verdictId: input.verdictId,
      rawSnapshotPath: snapshotResult.path,
      rawAttributionPath: attributionResult.path,
      harnessFeedbackRoot: deps.harnessFeedbackRoot,
      domain,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 500, error: 'Generator failed', detail: message };
  }

  // Roundtrip — verify hub read model includes the new verdict (砚砚 R0 P1 e2e).
  // Match by verdictId (hub item.id = basename, no .md) to avoid Mac /tmp symlink issues.
  const summary = loadEvalHubSummary({ harnessFeedbackRoot: deps.harnessFeedbackRoot });
  const found = summary.items.find((item) => item.id === input.verdictId);

  return {
    ok: true,
    domainId: 'eval:a2a',
    verdictId: input.verdictId,
    verdictPath: artifact.path,
    bundleDir: artifact.bundleDir,
    hubRoundtrip: { ok: Boolean(found), itemCount: summary.items.length },
    note: 'Generated to working tree. For permanent SOT, commit + push via PR/merge-gate. Verdict will NOT appear in deployed Eval Hub until committed to main.',
  };
}
