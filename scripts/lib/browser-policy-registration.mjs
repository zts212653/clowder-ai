import { execFileSync } from 'node:child_process';
import { isDeepStrictEqual } from 'node:util';

// The classifier is exported; the household browser catalog and policy are not.
export const BROWSER_IMPACT_POLICY_PATH = 'scripts/lib/browser-impact-policy.json';

const POLICY_KEYS = new Set(['schemaVersion', 'version', 'retirements', 'groups']);
const GROUP_KEYS = new Set(['id', 'kind', 'ownerRef', 'rationale', 'unitIds', 'selectionInputs', 'dependencyInputs']);

function assertKnownFields(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.has(key))) {
    throw new Error(`${label} contains an unknown shape or field`);
  }
}

function groupContract(group) {
  const { selectionInputs: _selectionInputs, ...contract } = group;
  return contract;
}

function policyGroups(policy) {
  assertKnownFields(policy, POLICY_KEYS, 'policy');
  if (
    policy.schemaVersion !== 1 ||
    typeof policy.version !== 'string' ||
    !policy.version ||
    !Array.isArray(policy.groups)
  ) {
    throw new Error('policy version or groups are invalid');
  }
  const ids = new Set();
  for (const group of policy.groups) {
    assertKnownFields(group, GROUP_KEYS, 'impact group');
    if (
      !/^[a-z0-9-]+$/u.test(group.id ?? '') ||
      ids.has(group.id) ||
      !['feature', 'contract', 'global'].includes(group.kind) ||
      typeof group.ownerRef !== 'string' ||
      !group.ownerRef ||
      typeof group.rationale !== 'string' ||
      !group.rationale.trim() ||
      !Array.isArray(group.unitIds) ||
      !group.unitIds.length ||
      group.unitIds.some((id) => typeof id !== 'string' || !id.startsWith('browser:')) ||
      new Set(group.unitIds).size !== group.unitIds.length ||
      !Array.isArray(group.selectionInputs) ||
      group.selectionInputs.some((input) => typeof input !== 'string')
    ) {
      throw new Error('impact group has an invalid or duplicate shape');
    }
    ids.add(group.id);
  }
  return policy.groups;
}

function assertExactAddition(input) {
  if (
    !input ||
    input.startsWith('/') ||
    [...input].some((c) => c.charCodeAt(0) < 32 || '\\*?[]{}'.includes(c)) ||
    input.split('/').some((part) => !part || part === '.' || part === '..')
  ) {
    throw new Error('new selection inputs must be exact repository paths');
  }
}

function preserveExistingGroups(previousGroups, remaining, addedInputs) {
  for (const old of previousGroups) {
    const current = remaining.get(old.id);
    if (!current || !isDeepStrictEqual(groupContract(old), groupContract(current))) {
      throw new Error(`existing impact group contract changed: ${old.id}`);
    }
    const oldInputs = new Set(old.selectionInputs);
    const currentInputs = new Set(current.selectionInputs);
    if ([...oldInputs].some((input) => !currentInputs.has(input))) {
      throw new Error(`existing selection input removed: ${old.id}`);
    }
    for (const input of currentInputs) {
      if (oldInputs.has(input)) continue;
      assertExactAddition(input);
      addedInputs.add(input);
    }
    remaining.delete(old.id);
  }
}

/** Classify coverage declarations, never authorize a green receipt or skip a required unit. */
export function assessBrowserPolicyRegistration(change) {
  try {
    if (!change) throw new Error('committed policy revision evidence is unavailable');
    const { before, after } = change;
    const previousGroups = policyGroups(before);
    const currentGroups = policyGroups(after);
    const { version: _beforeVersion, groups: _beforeGroups, ...beforeContract } = before;
    const { version: _afterVersion, groups: _afterGroups, ...afterContract } = after;
    if (!isDeepStrictEqual(beforeContract, afterContract)) throw new Error('policy schema or retirements changed');
    // Prove monotonic declarations against the committed baseline, not catalog
    // validity. The canonical browser planner still validates policy ownership,
    // quotas and complete required coverage before any validation can pass.
    const knownUnits = new Set(previousGroups.flatMap((group) => group.unitIds));
    const remaining = new Map(currentGroups.map((group) => [group.id, group]));
    const addedInputs = new Set();
    preserveExistingGroups(previousGroups, remaining, addedInputs);
    for (const group of remaining.values()) {
      if (
        group.kind !== 'contract' ||
        group.dependencyInputs !== undefined ||
        group.selectionInputs.length === 0 ||
        group.unitIds.some((id) => !knownUnits.has(id)) ||
        group.unitIds.length === knownUnits.size
      ) {
        throw new Error('new groups must be exact-input contract registrations for existing units');
      }
      for (const input of group.selectionInputs) {
        assertExactAddition(input);
        addedInputs.add(input);
      }
    }
    return {
      status: 'registration',
      addedInputs: [...addedInputs].sort(),
      addedGroupIds: [...remaining.keys()].sort(),
      ...(change.revisions ? { revisions: change.revisions } : {}),
    };
  } catch (error) {
    return { status: 'unproven', reason: error instanceof Error ? error.message : String(error) };
  }
}

function git(repoRoot, args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim();
}

function readJsonBlob(repoRoot, revision, file) {
  const entry = git(repoRoot, ['ls-tree', revision, '--', file]);
  if (!/^100644 blob [0-9a-f]{40}\t/u.test(entry)) throw new Error(`expected a regular committed JSON file: ${file}`);
  const blob = entry.split(/\s+/u)[2];
  return { blob, value: JSON.parse(git(repoRoot, ['show', `${revision}:${file}`])) };
}

/** Only the Git adapter supplies this pair; there is no CLI waiver or caller-supplied proof flag. */
export function readBrowserPolicyChange(repoRoot, baseSha, headSha, changedPaths = [BROWSER_IMPACT_POLICY_PATH]) {
  if (!changedPaths.includes(BROWSER_IMPACT_POLICY_PATH)) return null;
  try {
    const mergeBaseSha = git(repoRoot, ['merge-base', baseSha, headSha]);
    const before = readJsonBlob(repoRoot, mergeBaseSha, BROWSER_IMPACT_POLICY_PATH);
    const after = readJsonBlob(repoRoot, headSha, BROWSER_IMPACT_POLICY_PATH);
    const oldScripts = readJsonBlob(repoRoot, mergeBaseSha, 'packages/web/package.json').value.scripts;
    const newScripts = readJsonBlob(repoRoot, headSha, 'packages/web/package.json').value.scripts;
    if (!oldScripts || !newScripts || !isDeepStrictEqual(oldScripts, newScripts)) {
      throw new Error('browser unit membership or execution changed');
    }
    return {
      before: before.value,
      after: after.value,
      revisions: { mergeBaseSha, headSha, beforeBlob: before.blob, afterBlob: after.blob },
    };
  } catch {
    return null;
  }
}
