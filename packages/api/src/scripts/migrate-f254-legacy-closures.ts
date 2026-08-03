/**
 * Recover every frozen withheld invocation, then terminalize its legacy closure.
 * Dry-run is the default. This path never routes, queues, broadcasts, or advances cursors.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { migrateLegacyFreshnessClosure } from '../domains/cats/services/freshness/FreshnessClosureLegacyMigrationState.js';
import { RedisFreshnessClosureStore } from '../domains/cats/services/freshness/RedisFreshnessClosureStore.js';
import { RedisMessageStore } from '../domains/cats/services/stores/redis/RedisMessageStore.js';
import { applyRecoveryEntries } from './f254-withheld-message-recovery/core.js';
import {
  assertLegacyClosureMigrationWriteAllowed,
  type LegacyClosureMigrationBundle,
  validateLegacyClosureMigrationBundle,
} from './f254-withheld-message-recovery/legacy-closure-bundle.js';
import {
  buildLegacyClosureMigrationPlan,
  buildLegacyClosureTerminalInput,
  type LegacyClosureMigrationPlan,
} from './f254-withheld-message-recovery/legacy-closure-migration.js';

interface MigrationArgs {
  apply: boolean;
  help: boolean;
  bundlePath?: string;
  journalPath?: string;
  redisUrl?: string;
  keyPrefix?: string;
  approvalRef?: string;
  expectedBundleSha256?: string;
  confirmation?: string;
  actorId?: string;
}

const USAGE = `Usage: node dist/scripts/migrate-f254-legacy-closures.js --bundle <path> [options]

  --dry-run                        plan only (default)
  --apply                          recover messages, then terminalize fully-accounted closures
  --journal <path>                 required with --apply
  --redis-url <url>                override REDIS_URL
  --key-prefix <prefix>            override REDIS_KEY_PREFIX
  --approval-ref <message-id>      operator production approval reference
  --expected-bundle-sha256 <sha>   exact frozen bundle approved by operator
  --confirm "MIGRATE F254 LEGACY CLOSURES TO 6399"
  --actor-id <id>                  audit actor (default f254-legacy-migration)
`;

const VALUE_FLAGS: Record<string, Exclude<keyof MigrationArgs, 'apply' | 'help'>> = {
  '--bundle': 'bundlePath',
  '--journal': 'journalPath',
  '--redis-url': 'redisUrl',
  '--key-prefix': 'keyPrefix',
  '--approval-ref': 'approvalRef',
  '--expected-bundle-sha256': 'expectedBundleSha256',
  '--confirm': 'confirmation',
  '--actor-id': 'actorId',
};

function parseArgs(argv: readonly string[]): MigrationArgs {
  const parsed: MigrationArgs = { apply: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (applyBooleanFlag(parsed, arg)) continue;
    const field = arg ? VALUE_FLAGS[arg] : undefined;
    if (!field) throw new Error(`unknown argument: ${arg ?? '<missing>'}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    parsed[field] = value;
    index += 1;
  }
  if (!parsed.help && !parsed.bundlePath) throw new Error('--bundle is required');
  if (parsed.apply && !parsed.journalPath) throw new Error('--journal is required with --apply');
  return parsed;
}

function applyBooleanFlag(parsed: MigrationArgs, arg: string | undefined): boolean {
  if (arg === '--apply' || arg === '--dry-run') {
    parsed.apply = arg === '--apply';
    return true;
  }
  if (arg === '--help' || arg === '-h') {
    parsed.help = true;
    return true;
  }
  return false;
}

function formatPlan(plan: LegacyClosureMigrationPlan): string {
  const summary = plan.summary;
  return (
    `[f254-legacy-migration] closures=${plan.closures.length}, invocations=${plan.attachments.length}, ` +
    `formal=${summary.already_formal_exact}, recovered=${summary.already_recovered_exact}, ` +
    `recoverable=${summary.recoverable_text}, no_text=${summary.no_text}, conflict=${summary.conflict}`
  );
}

function redactedRedisTarget(redisUrl: string): string {
  const parsed = new URL(redisUrl);
  return `${parsed.protocol}//${parsed.hostname}:${parsed.port || '6379'}${parsed.pathname}`;
}

async function writeJournal(path: string, value: unknown): Promise<void> {
  const absolute = resolve(path);
  const temporary = `${absolute}.tmp-${process.pid}`;
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, absolute);
}

async function createStartedJournal(path: string, value: unknown): Promise<void> {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  try {
    await writeFile(absolute, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`migration journal already exists: ${absolute}`);
    }
    throw error;
  }
}

function buildPlan(
  bundle: LegacyClosureMigrationBundle,
  existingMessages: Awaited<ReturnType<RedisMessageStore['scanAll']>>,
) {
  return buildLegacyClosureMigrationPlan({
    activeClosures: bundle.closures,
    attachments: bundle.attachments,
    recoveryManifest: bundle.recoveryManifest,
    existingMessages,
    generatedAt: bundle.generatedAt,
  });
}

async function assertFrozenInventory(
  closureStore: RedisFreshnessClosureStore,
  bundle: LegacyClosureMigrationBundle,
): Promise<void> {
  const cutoff = Date.parse(bundle.legacyBeforeExclusive);
  const frozenIds = new Set(bundle.closures.map((closure) => closure.id));
  const unexpected = (await closureStore.listAllActive()).filter(
    (closure) => closure.createdAt < cutoff && !frozenIds.has(closure.id),
  );
  if (unexpected.length > 0) {
    throw new Error(`active legacy closure inventory drift: ${unexpected.map((item) => item.id).join(', ')}`);
  }
  for (const frozen of bundle.closures) {
    const current = await closureStore.get(frozen.id);
    if (!current) throw new Error(`frozen legacy closure is missing: ${frozen.id}`);
    if (current.status !== 'disposed' && current.revision !== frozen.revision) {
      throw new Error(`frozen legacy closure revision drift: ${frozen.id}`);
    }
  }
}

function authorizeApply(redisUrl: string, bundle: LegacyClosureMigrationBundle, args: MigrationArgs): void {
  const port = new URL(redisUrl).port || '6379';
  const authorization =
    process.env.CAT_CAFE_REDIS_TEST_ISOLATED === '1' && port !== '6398' && port !== '6399'
      ? ({ mode: 'isolated_test' } as const)
      : port === '6398'
        ? ({ mode: 'preview' } as const)
        : ({
            mode: 'production',
            approvalRef: args.approvalRef,
            expectedBundleSha256: args.expectedBundleSha256,
            confirmation: args.confirmation,
          } as const);
  assertLegacyClosureMigrationWriteAllowed(redisUrl, bundle, authorization);
}

async function recoverAndReplan(
  bundle: LegacyClosureMigrationBundle,
  initialPlan: LegacyClosureMigrationPlan,
  messageStore: RedisMessageStore,
) {
  const recoverableIds = new Set(
    initialPlan.closures.flatMap((closure) =>
      closure.invocations.filter((item) => item.outcome === 'recoverable_text').map((item) => item.invocationId),
    ),
  );
  const recovery = await applyRecoveryEntries({
    manifest: bundle.recoveryManifest,
    entries: bundle.recoveryManifest.entries.filter((entry) => recoverableIds.has(entry.invocationId)),
    messageStore,
    recoveredAt: Date.now(),
  });
  const finalPlan = buildPlan(bundle, await messageStore.scanAll());
  if (finalPlan.closures.some((closure) => !closure.fullyAccounted)) {
    throw new Error('recovery completed without a fully-accounted closure ledger');
  }
  return { recovery, finalPlan };
}

async function terminalizeClosures(input: {
  bundle: LegacyClosureMigrationBundle;
  finalPlan: LegacyClosureMigrationPlan;
  closureStore: RedisFreshnessClosureStore;
  actorId: string;
}) {
  const evidenceRef = `bundle:${input.bundle.bundleSha256}`;
  const terminalInputs = input.finalPlan.closures.map((closure) => ({
    closureId: closure.closureId,
    input: buildLegacyClosureTerminalInput(input.finalPlan, closure.closureId, {
      actorId: input.actorId,
      evidenceRef,
      now: Date.now(),
    }),
  }));
  for (const item of terminalInputs) {
    const current = await input.closureStore.get(item.closureId);
    if (!current) throw new Error(`frozen legacy closure is missing: ${item.closureId}`);
    migrateLegacyFreshnessClosure(current, item.input);
  }
  return Promise.all(terminalInputs.map((item) => input.closureStore.migrateLegacy(item.closureId, item.input)));
}

async function applyMigration(input: {
  args: MigrationArgs;
  redisUrl: string;
  bundle: LegacyClosureMigrationBundle;
  initialPlan: LegacyClosureMigrationPlan;
  closureStore: RedisFreshnessClosureStore;
  messageStore: RedisMessageStore;
}): Promise<number> {
  authorizeApply(input.redisUrl, input.bundle, input.args);
  if (!input.args.journalPath) throw new Error('--journal is required with --apply');
  await createStartedJournal(input.args.journalPath, {
    version: 1,
    status: 'started',
    incident: 'F254-legacy-closure-migration',
    bundleSha256: input.bundle.bundleSha256,
    recoveryManifestSha256: input.bundle.recoveryManifest.manifestSha256,
    migrationManifestSha256: input.initialPlan.migrationManifestSha256,
    redisTarget: redactedRedisTarget(input.redisUrl),
    startedAt: new Date().toISOString(),
    plannedClosureIds: input.initialPlan.closures.map((closure) => closure.closureId),
  });
  const { recovery, finalPlan } = await recoverAndReplan(input.bundle, input.initialPlan, input.messageStore);
  const migrated = await terminalizeClosures({
    bundle: input.bundle,
    finalPlan,
    closureStore: input.closureStore,
    actorId: input.args.actorId ?? 'f254-legacy-migration',
  });
  await writeJournal(input.args.journalPath, {
    version: 1,
    status: 'completed',
    incident: 'F254-legacy-closure-migration',
    bundleSha256: input.bundle.bundleSha256,
    recoveryManifestSha256: input.bundle.recoveryManifest.manifestSha256,
    migrationManifestSha256: finalPlan.migrationManifestSha256,
    redisTarget: redactedRedisTarget(input.redisUrl),
    completedAt: new Date().toISOString(),
    recoveredMessageIds: recovery.created.map((message) => message.id),
    alreadyPresentMessageIds: recovery.alreadyPresent.map((message) => message.id),
    closures: migrated.map((closure) => ({
      closureId: closure.id,
      revision: closure.revision,
      accountingSha256:
        closure.disposition?.kind === 'legacy_migrated' ? closure.disposition.accountingSha256 : undefined,
    })),
  });
  process.stdout.write(
    `[f254-legacy-migration] recovered=${recovery.created.length}, terminalized=${migrated.length}, ` +
      `journal=${resolve(input.args.journalPath)}\n`,
  );
  return 0;
}

async function runWithStores(input: {
  args: MigrationArgs;
  redisUrl: string;
  bundle: LegacyClosureMigrationBundle;
  closureStore: RedisFreshnessClosureStore;
  messageStore: RedisMessageStore;
}): Promise<number> {
  await assertFrozenInventory(input.closureStore, input.bundle);
  const initialPlan = buildPlan(input.bundle, await input.messageStore.scanAll());
  process.stdout.write(`${formatPlan(initialPlan)}\n`);
  if (initialPlan.summary.conflict > 0) {
    process.stderr.write('[f254-legacy-migration] REFUSED: accounting conflicts require investigation.\n');
    return 2;
  }
  if (!input.args.apply) {
    process.stdout.write('[f254-legacy-migration] DRY-RUN complete; zero writes performed.\n');
    return 0;
  }
  return applyMigration({ ...input, initialPlan });
}

export async function runLegacyClosureMigration(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!args.bundlePath) throw new Error('--bundle is required');
  const bundle = validateLegacyClosureMigrationBundle(JSON.parse(await readFile(resolve(args.bundlePath), 'utf8')));
  const redisUrl = args.redisUrl ?? process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL or --redis-url is required');
  const redis = createRedisClient({
    url: redisUrl,
    keyPrefix: args.keyPrefix ?? process.env.REDIS_KEY_PREFIX ?? 'cat-cafe:',
  });
  try {
    await redis.ping();
    const closureStore = new RedisFreshnessClosureStore(redis);
    const messageStore = new RedisMessageStore(redis);
    return await runWithStores({ args, redisUrl, bundle, closureStore, messageStore });
  } finally {
    await redis.quit();
  }
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runLegacyClosureMigration(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[f254-legacy-migration] failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath && entryPath === fileURLToPath(import.meta.url)) void main();
