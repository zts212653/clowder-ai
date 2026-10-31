/** Build a provenance-pinned F254 recovery manifest from the runtime census. */
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRecoveryCensus, type RecoveryCensusEntry } from './f254-withheld-message-recovery/census.js';
import { validateRecoveryManifest } from './f254-withheld-message-recovery/manifest.js';
import { scanRecoveryTranscriptFiles } from './f254-withheld-message-recovery/transcript-scan.js';

interface BuilderArgs {
  censusPath: string;
  transcriptRoot: string;
  sourceRoot: string;
  outputPath: string;
  cvoDecisionRef: string;
}

function readValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function parseArgs(argv: readonly string[]): BuilderArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!flag) throw new Error(`missing argument at index ${index}`);
    if (!['--census', '--transcript-root', '--source-root', '--out', '--cvo-decision-ref'].includes(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    values.set(flag, readValue(argv, index, flag));
  }
  const requireFlag = (flag: string): string => {
    const value = values.get(flag);
    if (!value) throw new Error(`${flag} is required`);
    return value;
  };
  return {
    censusPath: resolve(requireFlag('--census')),
    transcriptRoot: resolve(requireFlag('--transcript-root')),
    sourceRoot: resolve(requireFlag('--source-root')),
    outputPath: resolve(requireFlag('--out')),
    cvoDecisionRef: requireFlag('--cvo-decision-ref'),
  };
}

async function listEventFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && (entry.name === 'events.jsonl' || entry.name === 'events.live.jsonl'))
        files.push(path);
    }
  };
  await visit(root);
  return files;
}

async function resolveCandidateFiles(
  transcriptRoot: string,
  census: readonly RecoveryCensusEntry[],
): Promise<string[]> {
  const directories = new Set(census.map((entry) => join(transcriptRoot, 'threads', entry.threadId, entry.catId)));
  const nested = await Promise.all([...directories].sort().map(listEventFiles));
  return [...new Set(nested.flat())].sort();
}

function assertCensusIdentity(
  census: readonly RecoveryCensusEntry[],
  entries: ReturnType<typeof validateRecoveryManifest>['entries'],
): void {
  const byInvocation = new Map(census.map((item) => [item.invocationId, item]));
  for (const entry of entries) {
    const expected = byInvocation.get(entry.invocationId);
    if (!expected) throw new Error(`manifest invocation absent from census: ${entry.invocationId}`);
    if (entry.threadId !== expected.threadId || entry.catId !== expected.catId || entry.userId !== expected.userId) {
      throw new Error(`transcript identity disagrees with census for invocation ${entry.invocationId}`);
    }
    if (entry.timestamp > Date.parse(expected.withheldAtUtc)) {
      throw new Error(`transcript start occurs after withheld decision for invocation ${entry.invocationId}`);
    }
  }
}

export async function buildManifest(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  const censusRaw = await readFile(args.censusPath, 'utf8');
  const censusSource: unknown = JSON.parse(censusRaw);
  const census = parseRecoveryCensus(censusSource);
  const files = await resolveCandidateFiles(args.transcriptRoot, census);
  process.stdout.write(`[f254-manifest] scanning ${files.length} transcript files for ${census.length} invocations\n`);
  const scanned = await scanRecoveryTranscriptFiles({ targets: census, files, sourceRoot: args.sourceRoot });
  const manifest = validateRecoveryManifest({
    version: 1,
    incident: 'F254',
    generatedAt: new Date().toISOString(),
    cvoDecisionRef: args.cvoDecisionRef,
    entries: scanned.entries,
    censusSha256: createHash('sha256').update(censusRaw).digest('hex'),
    censusTotal: census.length,
    omissions: scanned.omittedNoTextInvocations.map((invocationId) => ({
      invocationId,
      reason: 'no_recoverable_text' as const,
    })),
  });
  assertCensusIdentity(census, manifest.entries);
  await writeFile(args.outputPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(
    `[f254-manifest] wrote ${manifest.entries.length} entries + ${manifest.omissions?.length ?? 0} omissions; ` +
      `sha256=${manifest.manifestSha256}\n`,
  );
}

async function main(): Promise<void> {
  try {
    await buildManifest(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[f254-manifest] failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath && entryPath === fileURLToPath(import.meta.url)) void main();
