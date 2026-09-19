import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publicTestArtifactFingerprint, validatePublicTestProvenance } from './public-test-provenance.mjs';
import { comparePublicTestStrings, publicTestInvariant as invariant } from './public-test-support.mjs';
import { publicTestSelectionHash } from './resolve-public-test-files.mjs';

export const DISTRIBUTABLE_PUBLIC_TEST_SHARDS = 6;
export const SHARED_SERIAL_LANE = 'serial-shared';

function digest(value) {
  return publicTestArtifactFingerprint(value);
}

export function normalizeSelectedFiles(selectedFiles) {
  invariant(Array.isArray(selectedFiles) && selectedFiles.length > 0, 'selectedFiles must be a non-empty array');
  const normalized = selectedFiles.map((file) => {
    invariant(
      typeof file === 'string' && file.startsWith('test/') && file.endsWith('.test.js'),
      'invalid selected test file',
    );
    return file;
  });
  invariant(new Set(normalized).size === normalized.length, 'selectedFiles contains duplicate files');
  return [...normalized].sort();
}

function compileClassification(classification) {
  invariant(classification && classification.version === 2, 'classification version must be 2');
  invariant(
    classification.defaultIsolationEvidence?.kind === 'kernel-no-egress-plus-runtime-guard' &&
      typeof classification.defaultIsolationEvidence.rulesVersion === 'string' &&
      typeof classification.defaultIsolationEvidence.source === 'string',
    'classification defaultIsolationEvidence is incomplete',
  );
  invariant(Array.isArray(classification.sharedResources), 'classification.sharedResources must be an array');
  const sharedResources = classification.sharedResources.map((rule) => {
    invariant(rule && typeof rule.id === 'string' && rule.id.length > 0, 'classification rule id is required');
    invariant(
      typeof rule.match === 'string' && rule.match.length > 0,
      `classification rule ${rule.id} match is required`,
    );
    let regex;
    try {
      regex = new RegExp(rule.match);
    } catch (error) {
      throw new Error(`classification rule ${rule.id} has invalid regex: ${error.message}`);
    }
    invariant(
      typeof rule.reason === 'string' && rule.reason.length > 0,
      `classification rule ${rule.id} reason is required`,
    );
    invariant(
      rule.sharedResourceEvidence?.kind === 'explicit-shared-resource' &&
        ['remote-endpoint', 'shared-account', 'shared-quota'].includes(rule.sharedResourceEvidence.scope) &&
        typeof rule.sharedResourceEvidence.source === 'string' &&
        rule.sharedResourceEvidence.source.length > 0,
      `classification rule ${rule.id} sharedResourceEvidence is incomplete`,
    );
    return { ...rule, regex };
  });
  return {
    defaultIsolationEvidence: classification.defaultIsolationEvidence,
    sharedResources,
  };
}

function classifyFile(file, classification) {
  const matches = classification.sharedResources.filter((rule) => rule.regex.test(file));
  invariant(matches.length <= 1, `classification has overlapping rules for ${file}`);
  if (matches.length === 0) {
    return {
      scope: 'distributable',
      ruleId: 'runtime-isolated-default',
      isolationEvidence: classification.defaultIsolationEvidence,
    };
  }
  const [rule] = matches;
  return {
    scope: 'shared',
    ruleId: rule.id,
    reason: rule.reason,
    sharedResourceEvidence: rule.sharedResourceEvidence,
  };
}

function durationFor(file, timingByFile) {
  const candidate = timingByFile?.[file];
  if (candidate === undefined) return 1_000;
  invariant(Number.isFinite(candidate) && candidate >= 0, `timing for ${file} must be a non-negative number`);
  return candidate;
}

function sortedShards(shards, prefix) {
  return [...shards]
    .sort(
      (left, right) =>
        left.estimatedDurationMs - right.estimatedDurationMs ||
        comparePublicTestStrings(left.files.join('\n'), right.files.join('\n')),
    )
    .map((shard, index) => ({
      id: `${prefix}-${index + 1}`,
      files: [...shard.files].sort(),
      estimatedDurationMs: shard.estimatedDurationMs,
    }));
}

function balancedShards(entries, shardCount, prefix) {
  const worklist = [...entries].sort(
    (left, right) => right.durationMs - left.durationMs || comparePublicTestStrings(left.file, right.file),
  );
  const shards = Array.from({ length: shardCount }, () => ({ files: [], estimatedDurationMs: 0 }));
  for (const entry of worklist) {
    const receiver = [...shards].sort(
      (left, right) =>
        left.estimatedDurationMs - right.estimatedDurationMs ||
        comparePublicTestStrings(left.files.join('\n'), right.files.join('\n')),
    )[0];
    receiver.files.push(entry.file);
    receiver.estimatedDurationMs += entry.durationMs;
  }
  return sortedShards(shards, prefix);
}

function normalizeTimingSource(source) {
  if (source === undefined) return { kind: 'unmeasured_default', estimatedDurationMs: 1_000 };
  invariant(source && typeof source === 'object' && !Array.isArray(source), 'timingSource must be an object');
  if (source.kind === 'unmeasured_default') {
    invariant(source.estimatedDurationMs === 1_000, 'unmeasured timing source must use the deterministic default');
    return { kind: 'unmeasured_default', estimatedDurationMs: 1_000 };
  }
  invariant(source.kind === 'public_test_shard_summary', 'timingSource kind is unsupported');
  invariant(
    typeof source.artifactFingerprint === 'string' && /^[0-9a-f]{64}$/.test(source.artifactFingerprint),
    'timingSource artifactFingerprint must be SHA-256',
  );
  return {
    kind: source.kind,
    artifactFingerprint: source.artifactFingerprint,
    provenance: validatePublicTestProvenance(source.provenance),
  };
}

function normalizePlannerProvenance(provenance) {
  return validatePublicTestProvenance(provenance);
}

function validateAssignmentEvidence(file, assignment) {
  if (/^distributable-/.test(assignment.lane)) {
    invariant(
      assignment.sharedResourceEvidence === undefined,
      `shared resource assignment cannot enter a distributable shard for ${file}`,
    );
    invariant(
      assignment.isolationEvidence?.kind === 'kernel-no-egress-plus-runtime-guard',
      `distributable assignment lacks kernel no-egress and runtime guard evidence for ${file}`,
    );
    return;
  }
  invariant(
    assignment.sharedResourceEvidence?.kind === 'explicit-shared-resource',
    `shared resource assignment lacks explicit evidence for ${file}`,
  );
}

export function validatePublicTestShardPlan(plan, selectedFiles) {
  invariant(plan && plan.schemaVersion === 2, 'shard plan schemaVersion must be 2');
  const expected = normalizeSelectedFiles(selectedFiles);
  invariant(
    plan.selectionHash === publicTestSelectionHash(expected),
    'shard plan selectionHash does not match selected files',
  );
  invariant(
    typeof plan.exclusionRegistryHash === 'string' && plan.exclusionRegistryHash.length > 0,
    'shard plan requires exclusion registry hash',
  );
  normalizePlannerProvenance(plan.plannerProvenance);
  normalizeTimingSource(plan.timingSource);
  invariant(
    Array.isArray(plan.distributableShards) && plan.distributableShards.length === DISTRIBUTABLE_PUBLIC_TEST_SHARDS,
    `shard plan requires ${DISTRIBUTABLE_PUBLIC_TEST_SHARDS} distributable shards`,
  );
  invariant(
    plan.sharedSerialLane?.id === SHARED_SERIAL_LANE && Array.isArray(plan.sharedSerialLane.files),
    'shard plan requires the shared serial lane',
  );
  const allShards = [plan.sharedSerialLane, ...plan.distributableShards];
  const validLaneIds = new Set(allShards.map((shard) => shard.id));
  invariant(validLaneIds.size === allShards.length, 'shard plan lane ids must be unique');
  const assigned = [
    ...plan.sharedSerialLane.files,
    ...plan.distributableShards.flatMap((shard, index) => {
      invariant(shard.id === `distributable-${index + 1}`, 'distributable shard ids must be stable and contiguous');
      invariant(Array.isArray(shard.files), 'distributable shard files must be an array');
      return shard.files;
    }),
  ].sort();
  invariant(
    assigned.length === expected.length && assigned.every((file, index) => file === expected[index]),
    'every selected public test must be assigned exactly once',
  );
  invariant(
    plan.assignments && typeof plan.assignments === 'object' && !Array.isArray(plan.assignments),
    'shard plan requires assignments',
  );
  const laneByFile = new Map();
  for (const shard of allShards) {
    for (const file of shard.files) laneByFile.set(file, shard.id);
  }
  for (const file of expected) {
    const assignment = plan.assignments[file];
    invariant(assignment && typeof assignment === 'object', `shard plan missing assignment for ${file}`);
    invariant(validLaneIds.has(assignment.lane), `shard plan has invalid lane for ${file}`);
    invariant(
      assignment.lane === laneByFile.get(file),
      `shard plan assignment lane does not match file placement for ${file}`,
    );
    invariant(
      typeof assignment.ruleId === 'string' && assignment.ruleId.length > 0,
      `shard plan missing classification for ${file}`,
    );
    validateAssignmentEvidence(file, assignment);
  }
  invariant(Object.keys(plan.assignments).length === expected.length, 'shard plan assignments contain unknown files');
  const withoutFingerprint = { ...plan };
  delete withoutFingerprint.planFingerprint;
  invariant(
    typeof plan.planFingerprint === 'string' && plan.planFingerprint === digest(withoutFingerprint),
    'shard plan fingerprint mismatch',
  );
  return plan;
}

export function planPublicTestShards({
  selectedFiles,
  selectionHash,
  exclusionRegistryHash,
  classification,
  plannerProvenance,
  timingByFile = {},
  timingSource,
}) {
  invariant(typeof selectionHash === 'string' && selectionHash.length > 0, 'selectionHash is required');
  const selected = normalizeSelectedFiles(selectedFiles);
  invariant(selectionHash === publicTestSelectionHash(selected), 'selectionHash does not match selectedFiles');
  invariant(
    typeof exclusionRegistryHash === 'string' && exclusionRegistryHash.length > 0,
    'exclusionRegistryHash is required',
  );
  const compiledClassification = compileClassification(classification);
  const sharedSerial = [];
  const distributable = [];
  for (const file of selected) {
    const classificationResult = classifyFile(file, compiledClassification);
    const durationMs = durationFor(file, timingByFile);
    const entry = { file, durationMs, ...classificationResult };
    if (classificationResult.scope === 'shared') sharedSerial.push(entry);
    else distributable.push(entry);
  }
  const plan = {
    schemaVersion: 2,
    selectionHash,
    selectedFiles: selected,
    exclusionRegistryHash,
    classificationVersion: classification.version,
    plannerProvenance: normalizePlannerProvenance(plannerProvenance),
    timingSource: normalizeTimingSource(timingSource),
    sharedSerialLane: {
      id: SHARED_SERIAL_LANE,
      files: sharedSerial.map((entry) => entry.file).sort(),
      estimatedDurationMs: sharedSerial.reduce((total, entry) => total + entry.durationMs, 0),
    },
    distributableShards: balancedShards(distributable, DISTRIBUTABLE_PUBLIC_TEST_SHARDS, 'distributable'),
  };
  const assignments = {};
  const entryByFile = new Map([...sharedSerial, ...distributable].map((entry) => [entry.file, entry]));
  for (const shard of [plan.sharedSerialLane]) {
    for (const file of shard.files) {
      const entry = entryByFile.get(file);
      assignments[file] = {
        lane: shard.id,
        ruleId: entry.ruleId,
        reason: entry.reason,
        sharedResourceEvidence: entry.sharedResourceEvidence,
        estimatedDurationMs: entry.durationMs,
      };
    }
  }
  for (const shard of plan.distributableShards) {
    for (const file of shard.files) {
      const entry = entryByFile.get(file);
      assignments[file] = {
        lane: shard.id,
        ruleId: entry.ruleId,
        isolationEvidence: entry.isolationEvidence,
        estimatedDurationMs: entry.durationMs,
      };
    }
  }
  plan.assignments = Object.fromEntries(
    Object.entries(assignments).sort(([left], [right]) => comparePublicTestStrings(left, right)),
  );
  plan.planFingerprint = digest(plan);
  return validatePublicTestShardPlan(plan, selected);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === resolve(fileURLToPath(import.meta.url))) {
  import('./plan-public-test-shards-cli.mjs')
    .then(({ runPublicTestShardPlannerCli }) => runPublicTestShardPlannerCli())
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
