/**
 * F254 incident salvage — restore withheld cat finals at their original time.
 *
 * This command never broadcasts, routes, wakes cats, mutates closure state, or
 * advances delivery/seen cursors. It is dry-run by default. Writes are limited
 * to preview Redis 6398 unless a production invocation carries a operator approval,
 * the exact approved manifest hash, and the literal confirmation phrase.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRedisClient } from '@cat-cafe/shared/utils';
import type { StoredMessage } from '../domains/cats/services/stores/ports/MessageStore.js';
import { RedisMessageStore } from '../domains/cats/services/stores/redis/RedisMessageStore.js';
import { parseRecoveryCliArgs } from './f254-withheld-message-recovery/cli.js';
import {
  applyRecoveryEntries,
  assertRecoveryWriteAllowed,
  planRecovery,
  type RecoveryPlan,
  validateRecoveryManifest,
} from './f254-withheld-message-recovery/core.js';

const USAGE = `Usage: node dist/scripts/restore-f254-withheld-messages.js --manifest <path> [options]

Options:
  --dry-run                         plan only (default)
  --apply                           execute approved writes
  --journal <path>                  required for --apply; atomically written audit journal
  --redis-url <url>                 override REDIS_URL
  --key-prefix <prefix>             override REDIS_KEY_PREFIX
  --approval-ref <message-id>       operator production approval reference
  --expected-manifest-sha256 <sha>  exact manifest hash approved by operator
  --confirm "RESTORE F254 TO 6399"   literal production confirmation
  --help                            show this help
`;

function formatPlan(plan: RecoveryPlan): string {
  const { summary } = plan;
  const lines = [
    `[f254-recovery] manifest sha256: ${plan.manifestSha256}`,
    `[f254-recovery] plan: insert=${summary.insert}, stream_companion=${summary.insert_stream_companion}, ` +
      `already_restored=${summary.already_restored}, already_formal=${summary.already_formal}, ` +
      `conflict=${summary.conflict}`,
  ];
  for (const item of plan.items) {
    lines.push(
      `[f254-recovery] ${item.outcome.padEnd(16)} ${item.entry.invocationId} ` +
        `${item.entry.threadId}/${item.entry.catId}` +
        (item.existingMessageId ? ` existing=${item.existingMessageId}` : '') +
        (item.reason ? ` reason=${item.reason}` : ''),
    );
  }
  return lines.join('\n');
}

function redactedRedisTarget(redisUrl: string): string {
  const parsed = new URL(redisUrl);
  return `${parsed.protocol}//${parsed.hostname}:${parsed.port || '6379'}${parsed.pathname}`;
}

async function writeJournal(
  path: string,
  journal: {
    manifestSha256: string;
    cvoDecisionRef: string;
    redisTarget: string;
    recoveredAt: number;
    created: Array<{ id: string; invocationId: string; threadId: string; contentSha256: string }>;
    alreadyPresent: Array<{ id: string; invocationId: string; threadId: string }>;
  },
): Promise<void> {
  const absolute = resolve(path);
  const temporary = `${absolute}.tmp-${process.pid}`;
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(temporary, `${JSON.stringify(journal, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  await rename(temporary, absolute);
}

function recoveryIdentity(message: StoredMessage): { invocationId: string; contentSha256: string } {
  const recovery = message.extra?.recovery;
  if (!recovery) throw new Error(`recovery result ${message.id} is missing its provenance marker`);
  return { invocationId: recovery.invocationId, contentSha256: recovery.contentSha256 };
}

export async function runRecovery(argv: readonly string[]): Promise<number> {
  const args = parseRecoveryCliArgs(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!args.manifestPath) throw new Error('--manifest is required');
  const manifestPath = resolve(args.manifestPath);
  const manifestSource = await readFile(manifestPath, 'utf8');
  const manifest = validateRecoveryManifest(JSON.parse(manifestSource));
  const redisUrl = args.redisUrl ?? process.env.REDIS_URL;
  if (!redisUrl) throw new Error('REDIS_URL or --redis-url is required');

  const redis = createRedisClient({
    url: redisUrl,
    keyPrefix: args.keyPrefix ?? process.env.REDIS_KEY_PREFIX ?? 'cat-cafe:',
  });
  try {
    await redis.ping();
    const messageStore = new RedisMessageStore(redis);
    const existingMessages = await messageStore.scanAll();
    const plan = planRecovery(manifest, existingMessages);
    process.stdout.write(`${formatPlan(plan)}\n`);
    if (plan.summary.conflict > 0) {
      process.stderr.write('[f254-recovery] REFUSED: identity/content conflicts require manual investigation.\n');
      return 2;
    }
    if (!args.apply) {
      process.stdout.write('[f254-recovery] DRY-RUN complete; zero writes performed.\n');
      return 0;
    }

    const port = new URL(redisUrl).port || '6379';
    assertRecoveryWriteAllowed(
      redisUrl,
      manifest,
      port === '6398'
        ? { mode: 'preview' }
        : {
            mode: 'production',
            approvalRef: args.approvalRef,
            expectedManifestSha256: args.expectedManifestSha256,
            confirmation: args.confirmation,
          },
    );
    const entries = plan.items
      .filter((item) => item.outcome === 'insert' || item.outcome === 'insert_stream_companion')
      .map((item) => item.entry);
    const recoveredAt = Date.now();
    const result = await applyRecoveryEntries({ manifest, entries, messageStore, recoveredAt });
    const entriesByInvocation = new Map(manifest.entries.map((entry) => [entry.invocationId, entry]));
    if (!args.journalPath) throw new Error('--journal is required with --apply');
    const journalPath = args.journalPath;
    await writeJournal(journalPath, {
      manifestSha256: result.manifestSha256,
      cvoDecisionRef: result.cvoDecisionRef,
      redisTarget: redactedRedisTarget(redisUrl),
      recoveredAt,
      created: result.created.map((message) => {
        const identity = recoveryIdentity(message);
        return { id: message.id, threadId: message.threadId, ...identity };
      }),
      alreadyPresent: result.alreadyPresent.map((message) => ({
        id: message.id,
        invocationId:
          message.extra?.recovery?.invocationId ??
          entriesByInvocation.get(message.extra?.stream?.turnInvocationId ?? '')?.invocationId ??
          'unknown',
        threadId: message.threadId,
      })),
    });
    process.stdout.write(
      `[f254-recovery] applied=${result.created.length}, already_present=${result.alreadyPresent.length}; ` +
        `journal=${resolve(journalPath)}\n`,
    );
    return 0;
  } finally {
    await redis.quit();
  }
}

async function main(): Promise<void> {
  try {
    process.exitCode = await runRecovery(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[f254-recovery] failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (entryPath && entryPath === fileURLToPath(import.meta.url)) void main();
