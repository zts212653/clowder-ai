/**
 * #1542: launch-plan builder for the managed Claude compaction carrier.
 *
 * One immutable plan drives BOTH the spawn (`--settings` injection in
 * ClaudeAgentService) and the compaction readiness decision (invoke-single-cat
 * consumes the exact plan it handed to the adapter — never a guessed project
 * root). The canonical carrier is the Node script (successor of the #1456
 * portable carrier, credited to @amazing-fish); the shell script stays a
 * bounded legacy compatibility, never a parallel standard.
 *
 * Contract (maintainer direction on #1542):
 * - resolves assets from the API/install root, NEVER from workingDirectory;
 * - reads no target-project `.claude/settings*.json` and writes nothing;
 * - the single-session settings document registers PreCompact + SessionStart
 *   with the same canonical Node handler shape and never sets
 *   `disableAllHooks: false`;
 * - ready means "this exact carrier will be handed to the CLI", which still
 *   cannot substitute for the current-invocation authenticated attestation.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLAUDE_COMPACTION_CARRIER_IDENTITY = 'f296-node-v1';

const CARRIER_SCRIPT_NAME = 'f24-compaction.mjs';
const REQUIRED_NODE_CARRIER_MARKERS = [
  '/api/sessions/seal',
  'CAT_CAFE_INVOCATION_ID',
  'CAT_CAFE_CALLBACK_TOKEN',
  'CAT_CAFE_CREDENTIAL_FILE',
  'X-Invocation-Id',
  'X-Callback-Token',
  'X-Clowder-Compaction-Carrier',
] as const;

export interface ClaudeCompactionLaunchPlan {
  readonly ready: true;
  /** Absolute path of the Node runtime that will execute the carrier. */
  readonly nodePath: string;
  /** Absolute path of the canonical Node carrier script (install-root resolved). */
  readonly carrierScriptPath: string;
  readonly carrierIdentity: typeof CLAUDE_COMPACTION_CARRIER_IDENTITY;
  readonly preCompactCommand: string;
  readonly sessionStartCommand: string;
  /** Single-session `--settings` document registering the canonical handlers. */
  readonly settingsDocument: string;
  /** Secret-free identity for logging/tests; never contains credentials. */
  readonly planIdentity: string;
}

export type ClaudeCompactionLaunchPlanResult =
  | ClaudeCompactionLaunchPlan
  | { readonly ready: false; readonly reason: 'carrier_script_unresolved' | 'carrier_script_invalid' };

export interface ClaudeCompactionLaunchPlanOptions {
  /** Install root for carrier asset resolution — never the invocation workingDirectory. */
  readonly installRoot?: string;
}

/**
 * Trusted install-root anchor (#1542 P1-2 + delta P1-A): derive ONE exact
 * install root from THIS MODULE's own location, never from process.cwd(), and
 * never search ancestors of that root. The carrier script executes with
 * invocation callback credentials, so a missing asset under the trusted root
 * must yield ready:false — never a marker-bearing script picked up from
 * outside the installation.
 *
 * Layout contract: the API package always lives at `<installRoot>/packages/api`
 * (repo checkout, desktop {app}); the module sits at a fixed depth under the
 * package. Walk up from the module to its package.json, validate the parent
 * really contains this package at `packages/api` (realpath-normalized so
 * Windows Apps/apps spellings and junctions compare by identity), then use
 * exactly `<installRoot>/.claude/hooks/f24-compaction.mjs` as the asset
 * coordinate. Explicit/env roots are trusted as-is and get the same single
 * exact coordinate — no ancestor search anywhere.
 */
function resolveTrustedInstallRoot(): string | undefined {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  let dir = moduleDir;
  for (let depth = 0; depth < 8; depth += 1) {
    if (existsSync(join(dir, 'package.json'))) {
      // packageRoot = <installRoot>/packages/api → installRoot is two levels up.
      const packageRoot = realpathSync.native(dir);
      const packagesDir = dirname(packageRoot);
      const installRoot = realpathSync.native(dirname(packagesDir));
      return realpathSync.native(join(installRoot, 'packages', 'api')) === packageRoot ? installRoot : undefined;
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
  return undefined;
}

/**
 * #1542 delta P1: explicit/env roots are canonicalized — resolved to an
 * absolute coordinate and realpath'd — before use. A relative root would
 * otherwise produce a relative carrier command that the claude child resolves
 * against ITS working directory, not the API process that judged readiness.
 * A root that does not exist fails closed (realpath throws).
 */
function canonicalizeRoot(root: string): string | undefined {
  try {
    return realpathSync.native(resolve(root));
  } catch {
    return undefined;
  }
}

function resolveInstallRoot(explicit?: string): string | undefined {
  if (explicit) return canonicalizeRoot(explicit);
  const envRoot = process.env.CAT_CAFE_COMPACTION_CARRIER_ROOT?.trim();
  if (envRoot) return canonicalizeRoot(envRoot);
  return resolveTrustedInstallRoot();
}

/**
 * True when path is the canonical root itself or a descendant of it.
 * #1542 delta review: platform-aware via path.relative — a hard-coded '/'
 * prefix rejected every legitimate Windows carrier path (backslash realpaths),
 * and the Windows Smoke job did not run this suite to catch it.
 */
function isInsideRoot(path: string, canonicalRoot: string): boolean {
  const rel = relative(canonicalRoot, path);
  if (rel === '') return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function managedPreCompactHookEntry(
  plan: Pick<ClaudeCompactionLaunchPlan, 'preCompactCommand'>,
): Record<string, unknown> {
  return {
    matcher: 'manual|auto',
    hooks: [{ type: 'command', command: plan.preCompactCommand, statusMessage: 'F24: Saving session state...' }],
  };
}

function managedSessionStartHookEntry(
  plan: Pick<ClaudeCompactionLaunchPlan, 'sessionStartCommand'>,
): Record<string, unknown> {
  return {
    matcher: 'compact',
    hooks: [{ type: 'command', command: plan.sessionStartCommand, statusMessage: 'F296: Restoring context...' }],
  };
}

/**
 * Compose the final single `--settings` document for one spawn.
 *
 * P1 guard (#1542 review): a user-supplied `--settings` must never silently
 * replace or drop the managed carrier, and two `--settings` flags must never
 * both reach the CLI. The user document (inline JSON or a file path) is merged
 * with the managed handlers into ONE document: user settings survive verbatim
 * (including `disableAllHooks: true`, which keeps its fail-closed semantics),
 * and the managed PreCompact/SessionStart entries are appended.
 *
 * P1-3 (#1542 re-review): a RELATIVE file path keeps its CLI meaning — the
 * claude child resolves it against the spawn workingDirectory, so this side
 * must resolve it against the same directory, never the API process CWD.
 */
export function composeManagedSettingsDocument(
  plan: ClaudeCompactionLaunchPlan,
  userSettings?: string,
  workingDirectory?: string,
): string {
  if (userSettings === undefined) return plan.settingsDocument;
  let userDoc: Record<string, unknown>;
  try {
    const raw = userSettings.trimStart().startsWith('{')
      ? userSettings
      : readFileSync(resolveUserSettingsPath(userSettings, workingDirectory), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecordLike(parsed)) throw new Error('not_an_object');
    userDoc = parsed;
  } catch {
    throw new Error('cli_config_args_settings_invalid');
  }
  const userHooks = isRecordLike(userDoc.hooks) ? userDoc.hooks : {};
  const merged: Record<string, unknown> = {
    ...userDoc,
    hooks: {
      ...userHooks,
      PreCompact: [...asArray(userHooks.PreCompact), managedPreCompactHookEntry(plan)],
      SessionStart: [...asArray(userHooks.SessionStart), managedSessionStartHookEntry(plan)],
    },
  };
  return `${JSON.stringify(merged, null, 2)}\n`;
}

function resolveUserSettingsPath(userSettings: string, workingDirectory?: string): string {
  if (isAbsolute(userSettings)) return userSettings;
  // Mirror the CLI: relative --settings paths resolve from the child's cwd.
  return resolve(workingDirectory ?? process.cwd(), userSettings);
}

function resolveCarrierScriptPath(installRoot: string): string {
  // Single exact coordinate under the trusted install root — no ancestors.
  return join(installRoot, '.claude', 'hooks', CARRIER_SCRIPT_NAME);
}

/**
 * Build the launch plan for one managed Claude spawn. Pure: touches no temp
 * files and reads no project settings, so readiness may build it freely.
 * Resolves exactly ONE asset coordinate under the trusted install root —
 * absence or staleness fails closed, never an ancestor escape.
 */
export function buildClaudeCompactionLaunchPlan(
  options: ClaudeCompactionLaunchPlanOptions = {},
): ClaudeCompactionLaunchPlanResult {
  const installRoot = resolveInstallRoot(options.installRoot);
  if (!installRoot) return { ready: false, reason: 'carrier_script_unresolved' };
  const joinedCarrierPath = resolveCarrierScriptPath(installRoot);
  let carrierScriptPath: string;
  let source: string;
  try {
    const stat = lstatSync(joinedCarrierPath);
    // Plain file only — the canonical carrier is packaged, not linked.
    if (!stat.isFile() || stat.isSymbolicLink()) return { ready: false, reason: 'carrier_script_unresolved' };
    // #1542 delta P1: intermediate `.claude`/`hooks` components may be links;
    // the RESOLVED carrier must remain a descendant of the canonical root, or
    // an install-boundary escape executes outside code with callback
    // credentials. The realpath is the coordinate handed to the CLI.
    carrierScriptPath = realpathSync.native(joinedCarrierPath);
    if (!isInsideRoot(carrierScriptPath, installRoot)) {
      return { ready: false, reason: 'carrier_script_unresolved' };
    }
    source = readFileSync(carrierScriptPath, 'utf8');
  } catch {
    // Absent asset under the trusted root — fail closed, never escape upward.
    return { ready: false, reason: 'carrier_script_unresolved' };
  }
  if (!REQUIRED_NODE_CARRIER_MARKERS.every((marker) => source.includes(marker))) {
    return { ready: false, reason: 'carrier_script_invalid' };
  }
  const nodePath = process.execPath;
  const preCompactCommand = `"${nodePath}" "${carrierScriptPath}" pre`;
  const sessionStartCommand = `"${nodePath}" "${carrierScriptPath}" post`;
  const partialPlan: Omit<ClaudeCompactionLaunchPlan, 'settingsDocument' | 'planIdentity'> = {
    ready: true,
    nodePath,
    carrierScriptPath,
    carrierIdentity: CLAUDE_COMPACTION_CARRIER_IDENTITY,
    preCompactCommand,
    sessionStartCommand,
  };
  const settingsDocument = `${JSON.stringify(
    {
      hooks: {
        PreCompact: [managedPreCompactHookEntry(partialPlan)],
        SessionStart: [managedSessionStartHookEntry(partialPlan)],
      },
    },
    null,
    2,
  )}\n`;
  const sourceDigest = createHash('sha256').update(source).digest('hex');
  const planIdentity = createHash('sha256')
    .update(`${nodePath}|${carrierScriptPath}|${sourceDigest}`)
    .digest('hex')
    .slice(0, 16);
  return {
    ready: true,
    nodePath,
    carrierScriptPath,
    carrierIdentity: CLAUDE_COMPACTION_CARRIER_IDENTITY,
    preCompactCommand,
    sessionStartCommand,
    settingsDocument,
    planIdentity,
  };
}
