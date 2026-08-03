/** Freeze every active pre-ADR-042 closure and its per-invocation transcript proof. */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { RedisFreshnessClosureStore } from '../domains/cats/services/freshness/RedisFreshnessClosureStore.js';
import { parseRecoveryCensus } from './f254-withheld-message-recovery/census.js';
import {
  buildLegacyClosureMigrationBundle,
  collectLegacyWithheldAttachments,
  parseLegacyWithheldLogLine,
} from './f254-withheld-message-recovery/legacy-closure-bundle.js';
import { validateRecoveryManifest } from './f254-withheld-message-recovery/manifest.js';
import { scanRecoveryTranscriptFiles } from './f254-withheld-message-recovery/transcript-scan.js';

interface BuilderArgs {
  censusPath: string;
  apiLogDir: string;
  transcriptRoot: string;
  sourceRoot: string;
  outputPath: string;
  cvoDecisionRef: string;
  legacyBeforeExclusive: string;
  redisUrl: string;
  keyPrefix: string;
}

const VALUE_FLAGS = new Set([
  '--census',
  '--api-log-dir',
  '--transcript-root',
  '--source-root',
  '--out',
  '--cvo-decision-ref',
  '--legacy-before',
  '--redis-url',
  '--key-prefix',
]);

function parseArgs(argv: readonly string[]): BuilderArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !VALUE_FLAGS.has(flag)) throw new Error(`unknown argument: ${flag ?? '<missing>'}`);
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    values.set(flag, value);
  }
  const required = (flag: string): string => {
    const value = values.get(flag);
    if (!value) throw new Error(`${flag} is required`);
    return value;
  };
  const legacyBeforeExclusive = required('--legacy-before');
  if (!Number.isFinite(Date.parse(legacyBeforeExclusive))) throw new Error('--legacy-before must be ISO');
  return {
    censusPath: resolve(required('--census')),
    apiLogDir: resolve(required('--api-log-dir')),
    transcriptRoot: resolve(required('--transcript-root')),
    sourceRoot: resolve(required('--source-root')),
    outputPath: resolve(required('--out')),
    cvoDecisionRef: required('--cvo-decision-ref'),
    legacyBeforeExclusive,
    redisUrl: required('--redis-url'),
    keyPrefix: values.get('--key-prefix') ?? 'cat-cafe:',
  };
}

async function listFiles(root: string, predicate: (name: string) => boolean): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && predicate(entry.name)) files.push(path);
    }
  };
  await visit(root);
  return files.sort();
}

function sourcePath(sourceRoot: string, path: string): string {
  const value = relative(sourceRoot, path);
  if (!value || value === '..' || value.startsWith(`..${sep}`)) {
    throw new Error(`evidence file is outside source root: ${path}`);
  }
  return value.split(sep).join('/');
}

async function readWithheldEvents(files: readonly string[], sourceRoot: string) {
  const events = [];
  for (const file of files) {
    const lines = createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
      const event = parseLegacyWithheldLogLine(line, sourcePath(sourceRoot, file), lineNumber);
      if (event) events.push(event);
    }
  }
  return events;
}

async function transcriptFilesForClosures(
  transcriptRoot: string,
  closures: readonly { threadId: string; catId: string }[],
): Promise<string[]> {
  const roots = [
    ...new Set(closures.map((closure) => join(transcriptRoot, 'threads', closure.threadId, closure.catId))),
  ];
  const nested = await Promise.all(
    roots.sort().map((root) => listFiles(root, (name) => name === 'events.jsonl' || name === 'events.live.jsonl')),
  );
  return [...new Set(nested.flat())].sort();
}

export async function buildLegacyBundle(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  const redis = createRedisClient({ url: args.redisUrl, keyPrefix: args.keyPrefix });
  try {
    await redis.ping();
    const closureStore = new RedisFreshnessClosureStore(redis);
    const cutoff = Date.parse(args.legacyBeforeExclusive);
    const closures = (await closureStore.listAllActive()).filter((closure) => closure.createdAt < cutoff);
    if (closures.length === 0) throw new Error('no active legacy closures found before cutoff');

    const censusRaw = await readFile(args.censusPath, 'utf8');
    const census = parseRecoveryCensus(JSON.parse(censusRaw) as unknown);
    const apiLogFiles = await listFiles(args.apiLogDir, (name) => /^api\..+\.log$/u.test(name));
    const logEvents = await readWithheldEvents(apiLogFiles, args.sourceRoot);
    const attachments = collectLegacyWithheldAttachments({
      closures,
      census,
      logEvents,
      legacyBeforeExclusive: args.legacyBeforeExclusive,
    });
    const closureById = new Map(closures.map((closure) => [closure.id, closure]));
    const targets = attachments.map((attachment) => {
      const closure = closureById.get(attachment.closureId);
      if (!closure || !attachment.withheldDecision) {
        throw new Error(`attachment lacks closure or withheld decision: ${attachment.invocationId}`);
      }
      return {
        invocationId: attachment.invocationId,
        userId: closure.userId,
        withheldDecision: attachment.withheldDecision,
      };
    });
    const transcriptFiles = await transcriptFilesForClosures(args.transcriptRoot, closures);
    process.stdout.write(
      `[f254-legacy-bundle] scanning ${transcriptFiles.length} transcript files for ${targets.length} invocations\n`,
    );
    const scanned = await scanRecoveryTranscriptFiles({
      targets,
      files: transcriptFiles,
      sourceRoot: args.sourceRoot,
    });
    const recoveryManifest = validateRecoveryManifest({
      version: 1,
      incident: 'F254',
      generatedAt: new Date().toISOString(),
      cvoDecisionRef: args.cvoDecisionRef,
      entries: scanned.entries,
      censusSha256: createHash('sha256').update(JSON.stringify(attachments)).digest('hex'),
      censusTotal: attachments.length,
      omissions: scanned.omittedNoTextInvocations.map((invocationId) => ({
        invocationId,
        reason: 'no_recoverable_text' as const,
      })),
    });
    const bundle = buildLegacyClosureMigrationBundle({
      generatedAt: recoveryManifest.generatedAt,
      legacyBeforeExclusive: args.legacyBeforeExclusive,
      cvoDecisionRef: args.cvoDecisionRef,
      closures,
      attachments,
      recoveryManifest,
    });
    await writeFile(args.outputPath, `${JSON.stringify(bundle, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    process.stdout.write(
      `[f254-legacy-bundle] closures=${bundle.closures.length}, invocations=${bundle.attachments.length}, ` +
        `recoverable=${bundle.recoveryManifest.entries.length}, no_text=${bundle.recoveryManifest.omissions?.length ?? 0}, ` +
        `bundle_sha256=${bundle.bundleSha256}\n`,
    );
  } finally {
    await redis.quit();
  }
}

async function main(): Promise<void> {
  try {
    await buildLegacyBundle(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[f254-legacy-bundle] failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath && entryPath === fileURLToPath(import.meta.url)) void main();
