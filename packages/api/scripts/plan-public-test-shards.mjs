import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { publicTestArtifactFingerprint, validatePublicTestProvenance } from './public-test-provenance.mjs';
import { comparePublicTestStrings, publicTestInvariant as invariant } from './public-test-support.mjs';
import { publicTestSelectionHash } from './resolve-public-test-files.mjs';

export const MIN_PUBLIC_TEST_SHARDS = 4;
const MAX_SHARDS = 6;

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
  invariant(classification && classification.version === 1, 'classification version must be 1');
  invariant(Array.isArray(classification.rules), 'classification.rules must be an array');
  return classification.rules.map((rule) => {
    invariant(rule && typeof rule.id === 'string' && rule.id.length > 0, 'classification rule id is required');
    invariant(
      typeof rule.match === 'string' && rule.match.length > 0,
      `classification rule ${rule.id} match is required`,
    );
    invariant(rule.lane === 'serial' || rule.lane === 'pure', `classification rule ${rule.id} lane is invalid`);
    let regex;
    try {
      regex = new RegExp(rule.match);
    } catch (error) {
      throw new Error(`classification rule ${rule.id} has invalid regex: ${error.message}`);
    }
    if (rule.lane === 'serial') {
      invariant(
        typeof rule.reason === 'string' && rule.reason.length > 0,
        `classification rule ${rule.id} reason is required`,
      );
    } else {
      invariant(
        rule.isolationEvidence && typeof rule.isolationEvidence === 'object',
        `classification rule ${rule.id} requires isolationEvidence`,
      );
      invariant(
        typeof rule.isolationEvidence.kind === 'string' &&
          typeof rule.isolationEvidence.rulesVersion === 'string' &&
          typeof rule.isolationEvidence.source === 'string',
        `classification rule ${rule.id} isolationEvidence is incomplete`,
      );
    }
    return { ...rule, regex };
  });
}

function classifyFile(file, rules, isolationAuditByFile) {
  const matches = rules.filter((rule) => rule.regex.test(file));
  invariant(matches.length <= 1, `classification has overlapping rules for ${file}`);
  if (matches.length === 0) {
    return { lane: 'serial', ruleId: 'default-serial', reason: 'unproven isolation defaults to serial' };
  }
  const [rule] = matches;
  if (rule.lane === 'serial') return { lane: 'serial', ruleId: rule.id, reason: rule.reason };
  const audit = isolationAuditByFile?.[file];
  if (!audit?.ok) {
    return {
      lane: 'serial',
      ruleId: `audit-${rule.id}`,
      reason: audit?.reason ?? 'missing current isolation proof',
    };
  }
  return {
    lane: 'pure',
    ruleId: rule.id,
    isolationEvidence: audit?.evidence ?? rule.isolationEvidence,
  };
}

function durationFor(file, timingByFile) {
  const candidate = timingByFile?.[file];
  if (candidate === undefined) return 1_000;
  invariant(Number.isFinite(candidate) && candidate >= 0, `timing for ${file} must be a non-negative number`);
  return candidate;
}

function sortedShards(shards) {
  return [...shards]
    .sort(
      (left, right) =>
        left.estimatedDurationMs - right.estimatedDurationMs ||
        comparePublicTestStrings(left.files.join('\n'), right.files.join('\n')),
    )
    .map((shard, index) => ({
      id: `pure-${index + 1}`,
      files: [...shard.files].sort(),
      estimatedDurationMs: shard.estimatedDurationMs,
    }));
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

export function validatePublicTestShardPlan(plan, selectedFiles) {
  invariant(plan && plan.schemaVersion === 1, 'shard plan schemaVersion must be 1');
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
  invariant(plan.lanes?.serial && Array.isArray(plan.lanes.serial.files), 'shard plan requires serial lane');
  invariant(
    Array.isArray(plan.pureShards) &&
      plan.pureShards.length >= MIN_PUBLIC_TEST_SHARDS &&
      plan.pureShards.length <= MAX_SHARDS,
    'shard plan requires 4–6 pure shards',
  );
  const assigned = [
    ...plan.lanes.serial.files,
    ...plan.pureShards.flatMap((shard) => {
      invariant(Array.isArray(shard.files), 'pure shard files must be an array');
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
  const laneByFile = new Map(plan.lanes.serial.files.map((file) => [file, 'serial']));
  for (const shard of plan.pureShards) {
    for (const file of shard.files) laneByFile.set(file, shard.id);
  }
  for (const file of expected) {
    const assignment = plan.assignments[file];
    invariant(assignment && typeof assignment === 'object', `shard plan missing assignment for ${file}`);
    invariant(
      assignment.lane === 'serial' || /^pure-[1-6]$/.test(assignment.lane),
      `shard plan has invalid lane for ${file}`,
    );
    invariant(
      assignment.lane === laneByFile.get(file),
      `shard plan assignment lane does not match file placement for ${file}`,
    );
    invariant(
      typeof assignment.ruleId === 'string' && assignment.ruleId.length > 0,
      `shard plan missing classification for ${file}`,
    );
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
  isolationAuditByFile,
  shardCount = MIN_PUBLIC_TEST_SHARDS,
}) {
  invariant(
    Number.isInteger(shardCount) && shardCount >= MIN_PUBLIC_TEST_SHARDS && shardCount <= MAX_SHARDS,
    'shardCount must be 4–6',
  );
  invariant(typeof selectionHash === 'string' && selectionHash.length > 0, 'selectionHash is required');
  const selected = normalizeSelectedFiles(selectedFiles);
  invariant(selectionHash === publicTestSelectionHash(selected), 'selectionHash does not match selectedFiles');
  invariant(
    typeof exclusionRegistryHash === 'string' && exclusionRegistryHash.length > 0,
    'exclusionRegistryHash is required',
  );
  const rules = compileClassification(classification);
  const serial = [];
  const pure = [];
  for (const file of selected) {
    const classificationResult = classifyFile(file, rules, isolationAuditByFile);
    const durationMs = durationFor(file, timingByFile);
    if (classificationResult.lane === 'serial') serial.push({ file, durationMs, ...classificationResult });
    else pure.push({ file, durationMs, ...classificationResult });
  }
  const worklist = [...pure].sort(
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
  const plan = {
    schemaVersion: 1,
    selectionHash,
    selectedFiles: selected,
    exclusionRegistryHash,
    classificationVersion: classification.version,
    plannerProvenance: normalizePlannerProvenance(plannerProvenance),
    timingSource: normalizeTimingSource(timingSource),
    lanes: {
      serial: {
        files: serial.map((entry) => entry.file).sort(),
        estimatedDurationMs: serial.reduce((total, entry) => total + entry.durationMs, 0),
      },
    },
    pureShards: sortedShards(shards),
  };
  const assignments = {};
  for (const entry of serial) {
    assignments[entry.file] = {
      lane: 'serial',
      ruleId: entry.ruleId,
      reason: entry.reason,
      estimatedDurationMs: entry.durationMs,
    };
  }
  for (const shard of plan.pureShards) {
    for (const file of shard.files) {
      const entry = pure.find((candidate) => candidate.file === file);
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

const STATIC_STATEFUL_MARKERS = [
  { id: 'redis', pattern: /\b(?:redis|ioredis|redisClient|redisStore|REDIS_URL)\b/i },
  { id: 'port', pattern: /\b(?:createServer|API_SERVER_PORT|FRONTEND_PORT)\b|\blisten\s*\(|localhost:/i },
  { id: 'filesystem-watch', pattern: /\b(?:fs\.watch|watchFile|watchpack|chokidar)\b/i },
  {
    id: 'filesystem-write',
    pattern: /\b(?:writeFile|appendFile|mkdir|mkdtemp|rename|unlink|rmSync?|chmod|copyFile)\b/i,
  },
  { id: 'process', pattern: /\bchild_process\b|\b(?:spawn|spawnSync|execFile|execSync|fork)\s*\(/i },
  { id: 'worker', pattern: /\bworker_threads\b|\bnew\s+Worker\s*\(/i },
  { id: 'network', pattern: /\b(?:fetch|WebSocket)\s*\(|\b(?:http|https)\.request\b|\bundici\b/i },
  { id: 'dynamic-module-load', pattern: /\b(?:import|require)\s*\(/ },
];

export async function auditPublicTestIsolation({ selectedFiles, packageRoot }) {
  const audit = {};
  for (const file of normalizeSelectedFiles(selectedFiles)) {
    const source = await readFile(resolve(packageRoot, file), 'utf8');
    const matched = STATIC_STATEFUL_MARKERS.filter((marker) => marker.pattern.test(source)).map((marker) => marker.id);
    if (matched.length > 0) {
      audit[file] = { ok: false, reason: `static isolation audit found ${matched.join(', ')}` };
    } else {
      audit[file] = {
        ok: true,
        evidence: {
          kind: 'static-negative-scan',
          rulesVersion: 'f308-static-v1',
          source: `sha256:${digest(source)}`,
        },
      };
    }
  }
  return audit;
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
