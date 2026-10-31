import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { planPublicTestShards } from './plan-public-test-shards.mjs';
import { normalizePublicTestCliArgv } from './public-test-cli-args.mjs';
import {
  currentPublicTestProvenance,
  publicTestArtifactFingerprint,
  samePublicTestProvenance,
  validatePublicTestProvenance,
} from './public-test-provenance.mjs';
import {
  atomicPublicTestJsonWrite,
  parsePublicTestCliOptions,
  publicTestInvariant,
  readPublicTestJson,
} from './public-test-support.mjs';
import { buildPublicTestManifest, resolvePublicTestFiles } from './resolve-public-test-files.mjs';

export function timingMapFromSummary({ summary, manifest, provenance }) {
  publicTestInvariant(
    (summary?.schemaVersion === 1 || summary?.schemaVersion === 2) &&
      summary.kind === 'public_test_shard_summary' &&
      summary.status === 'succeeded',
    'timing artifact must be a green public-test shard summary',
  );
  publicTestInvariant(
    summary.selectionHash === manifest.selectionHash,
    'timing summary selection hash does not match current manifest',
  );
  publicTestInvariant(
    summary.exclusionRegistryHash === manifest.exclusionRegistryHash,
    'timing summary exclusion registry does not match current manifest',
  );
  publicTestInvariant(
    summary.selectedFileCount === manifest.selectedFiles.length,
    'timing summary selected-file count is stale',
  );
  publicTestInvariant(
    samePublicTestProvenance(summary.provenance, provenance),
    'timing summary provenance does not match current workspace, lockfile, toolchain, or runner',
  );
  const timings = summary.perFileTimings;
  publicTestInvariant(
    timings && typeof timings === 'object' && !Array.isArray(timings),
    'timing summary perFileTimings is required',
  );
  const actualFiles = Object.keys(timings).sort();
  publicTestInvariant(
    actualFiles.length === manifest.selectedFiles.length &&
      actualFiles.every((file, index) => file === manifest.selectedFiles[index]),
    'timing summary does not cover the current selected files exactly once',
  );
  for (const [file, durationMs] of Object.entries(timings)) {
    publicTestInvariant(
      Number.isFinite(durationMs) && durationMs >= 0,
      `timing summary duration is invalid for ${file}`,
    );
  }
  return {
    timingByFile: timings,
    timingSource: {
      kind: 'public_test_shard_summary',
      artifactFingerprint: publicTestArtifactFingerprint(summary),
      provenance: validatePublicTestProvenance(summary.provenance),
    },
  };
}

export async function runPublicTestShardPlannerCli(argv = process.argv.slice(2)) {
  const options = parsePublicTestCliOptions(normalizePublicTestCliArgv(argv));
  if (options.help) {
    process.stdout.write(
      'Usage: node packages/api/scripts/plan-public-test-shards.mjs --output <path> [--timings <path>] [--classification <path>]\n',
    );
    return;
  }
  if (!options.output) throw new Error('--output is required');
  const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const classificationPath = resolve(
    options.classification ?? `${packageRoot}/config/public-test-shard-classification.json`,
  );
  const classification = await readPublicTestJson(
    classificationPath,
    'could not load public-test shard classification',
  );
  const manifest = buildPublicTestManifest(await resolvePublicTestFiles({ packageRoot }));
  const provenance = currentPublicTestProvenance(packageRoot);
  const timing = options.timings
    ? timingMapFromSummary({
        summary: await readPublicTestJson(options.timings, 'could not load timing artifact'),
        manifest,
        provenance,
      })
    : { timingByFile: {}, timingSource: { kind: 'unmeasured_default', estimatedDurationMs: 1_000 } };
  const plan = planPublicTestShards({
    selectedFiles: manifest.selectedFiles,
    selectionHash: manifest.selectionHash,
    exclusionRegistryHash: manifest.exclusionRegistryHash,
    classification,
    plannerProvenance: provenance,
    timingByFile: timing.timingByFile,
    timingSource: timing.timingSource,
  });
  await atomicPublicTestJsonWrite(options.output, plan);
  const sharedSerialFiles = plan.sharedSerialLane.files.length;
  const distributableFiles = plan.distributableShards.reduce((total, shard) => total + shard.files.length, 0);
  process.stdout.write(
    `public-test shard plan: selected=${plan.selectedFiles.length} serial_shared=${sharedSerialFiles} distributable=${distributableFiles} distributable_shards=${plan.distributableShards.length} fingerprint=${plan.planFingerprint}\n`,
  );
}
