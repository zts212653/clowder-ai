/** Exact, provenance-checked cleanup planning for F302 and legacy F070 installs. */

import { readFile, readlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { BootstrapAction, BootstrapReport } from '@cat-cafe/shared';
import { pathsEqual } from '../../utils/project-path.js';
import {
  governancePathExists,
  hashGovernanceContent,
  hasUnsafeGovernanceAncestor,
  LEGACY_GOVERNANCE_REPORT,
  safeGovernanceTargetPath,
} from './governance-bootstrap-plan.js';

const PROTECTED_CLEANUP_PATH = '.cat-cafe/capabilities.json';

export function isProtectedGovernanceCleanupTarget(targetProject: string, target: string): boolean {
  const protectedTarget = safeGovernanceTargetPath(targetProject, PROTECTED_CLEANUP_PATH);
  if (!protectedTarget) return true;
  // Fail closed on ASCII case aliases regardless of the host volume's case-sensitivity.
  return target.toLowerCase() === protectedTarget.toLowerCase();
}

function skipped(file: string, reason: string): BootstrapAction {
  return { file, action: 'skipped', group: 'legacy-cleanup', reason };
}

async function planCreatedFile(target: string, source: BootstrapAction): Promise<BootstrapAction> {
  const current = source.contentHash ? await readFile(target, 'utf8').catch(() => null) : null;
  const matches = current !== null && hashGovernanceContent(current) === source.contentHash;
  const reason = matches
    ? 'generated content still matches'
    : source.contentHash
      ? 'content changed'
      : 'legacy action lacks content hash';
  return { file: source.file, action: matches ? 'deleted' : 'skipped', group: 'legacy-cleanup', reason };
}

async function planSymlink(target: string, source: BootstrapAction): Promise<BootstrapAction> {
  const expected = source.symlinkTarget ?? source.reason.match(/linked to (.+)$/)?.[1];
  const currentTarget = await readlink(target).catch(() => null);
  const matches = Boolean(
    expected && currentTarget && pathsEqual(resolve(dirname(target), currentTarget), resolve(expected)),
  );
  return {
    file: source.file,
    action: matches ? 'deleted' : 'skipped',
    group: 'legacy-cleanup',
    reason: matches ? 'generated symlink target still matches' : 'symlink target changed or unavailable',
  };
}

async function planCandidate(targetProject: string, source: BootstrapAction): Promise<BootstrapAction | null> {
  if (source.action !== 'created' && source.action !== 'symlinked') return null;
  const target = safeGovernanceTargetPath(targetProject, source.file);
  if (!target) return skipped(source.file, 'path escapes project root');
  if (isProtectedGovernanceCleanupTarget(targetProject, target)) {
    return skipped(source.file, 'protected shared config');
  }
  if (await hasUnsafeGovernanceAncestor(targetProject, target)) {
    return skipped(source.file, 'parent path is a symlink or non-directory');
  }
  if (!(await governancePathExists(target))) return skipped(source.file, 'candidate already absent');
  return source.action === 'created' ? planCreatedFile(target, source) : planSymlink(target, source);
}

async function planLegacyReport(targetProject: string, actions: readonly BootstrapAction[]): Promise<BootstrapAction> {
  const allDisposed = actions
    .filter((action) => action.reason !== 'protected shared config')
    .every((action) => action.action === 'deleted' || action.reason === 'candidate already absent');
  const reportTarget = safeGovernanceTargetPath(targetProject, LEGACY_GOVERNANCE_REPORT);
  if (!reportTarget) return skipped(LEGACY_GOVERNANCE_REPORT, 'path escapes project root');
  if (await hasUnsafeGovernanceAncestor(targetProject, reportTarget)) {
    return skipped(LEGACY_GOVERNANCE_REPORT, 'parent path is a symlink or non-directory');
  }
  const reportExists = await governancePathExists(reportTarget);
  const reason = !reportExists
    ? 'legacy report already absent'
    : allDisposed
      ? 'all generated candidates are disposed'
      : 'generated candidates remain';
  return {
    file: LEGACY_GOVERNANCE_REPORT,
    action: allDisposed && reportExists ? 'deleted' : 'skipped',
    group: 'legacy-cleanup',
    reason,
  };
}

export async function planGovernanceCleanup(
  targetProject: string,
  sourceReport?: BootstrapReport,
  includeLegacyReport = false,
): Promise<BootstrapAction[]> {
  if (!sourceReport) return [];
  const planned = await Promise.all(sourceReport.actions.map((source) => planCandidate(targetProject, source)));
  const actions = planned.filter((action): action is BootstrapAction => action !== null);
  if (includeLegacyReport) actions.push(await planLegacyReport(targetProject, actions));
  return actions;
}
