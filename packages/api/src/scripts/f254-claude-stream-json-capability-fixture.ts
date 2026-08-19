import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { createRedisClient } from '@cat-cafe/shared/utils';
import { createContentFreeFreshnessNotice } from '../domains/cats/services/freshness/FreshnessNoticeBroker.js';

const redisUrl = process.env.REDIS_URL ?? '';
const parsedRedisUrl = new URL(redisUrl);
if (parsedRedisUrl.port !== '6398') {
  throw new Error(`F254 Claude capability fixture requires Redis 6398, received ${parsedRedisUrl.host || '<missing>'}`);
}

const fixtureId = randomUUID();
const unseenKey = `fixture:${fixtureId}:unseen`;
const redis = createRedisClient({ url: redisUrl, keyPrefix: 'catcafe:f254-live:' });
const child = spawn(
  process.env.CLAUDE_BIN ?? 'claude',
  [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--replay-user-messages',
    '--dangerously-skip-permissions',
    '--model',
    process.env.F254_CLAUDE_MODEL ?? process.env.CAT_OPUS_MODEL ?? 'claude-opus-4-6',
    '--tools',
    'Bash',
  ],
  { cwd: process.cwd(), env: process.env, stdio: ['pipe', 'pipe', 'pipe'] },
);
const exitPromise = once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>;

const noticeText = createContentFreeFreshnessNotice({ threadId: fixtureId, unseenCount: 1 });
let commandStarted = false;
let noticeWritten = false;
let transportAck = false;
let cognitionSeen = false;
let resultCountBeforeNotice = 0;
let resultCount = 0;
const observedEventTypes = new Set<string>();
const observedEvents: Array<Record<string, unknown>> = [];
const stderr: string[] = [];
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk: string) => stderr.push(chunk));

function writeUser(content: string): void {
  child.stdin.write(
    `${JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: content }] },
      session_id: '',
      parent_tool_use_id: null,
    })}\n`,
  );
}

function contentBlocks(event: Record<string, unknown>): Array<Record<string, unknown>> {
  const message = event.message as Record<string, unknown> | undefined;
  return Array.isArray(message?.content)
    ? message.content.filter((value): value is Record<string, unknown> => typeof value === 'object' && value !== null)
    : [];
}

const timeout = setTimeout(() => child.kill('SIGTERM'), 90_000);
try {
  writeUser(
    'Run the Bash command `sleep 2 && printf ready` now. If a later user message begins with "📬 freshness notice", reply exactly CLAUDE_FRESHNESS_SEEN.',
  );

  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    if (!line.trim()) continue;
    const event = JSON.parse(line) as Record<string, unknown>;
    observedEventTypes.add(String(event.type ?? '<missing>'));
    observedEvents.push(event);
    if (observedEvents.length > 12) observedEvents.shift();
    if (event.type === 'result') resultCount++;
    const blocks = contentBlocks(event);
    if (
      event.type === 'assistant' &&
      blocks.some((block) => block.type === 'tool_use' && block.name === 'Bash') &&
      !commandStarted
    ) {
      commandStarted = true;
      await redis.set(
        unseenKey,
        JSON.stringify({ count: 1, senders: ['fixture-user'], maxMessageId: `${fixtureId}:message-1` }),
      );
    }
    const completedBash =
      event.type === 'user' && blocks.some((block) => block.type === 'tool_result') && commandStarted;
    if (completedBash && !noticeWritten) {
      resultCountBeforeNotice = resultCount;
      writeUser(noticeText);
      noticeWritten = true;
      child.stdin.end();
    }
    const serialized = JSON.stringify(event);
    if (noticeWritten && event.type === 'user' && serialized.includes(noticeText)) transportAck = true;
    if (noticeWritten && event.type === 'assistant' && serialized.includes('CLAUDE_FRESHNESS_SEEN')) {
      cognitionSeen = true;
    }
    if (event.type === 'result' && !commandStarted) {
      child.stdin.end();
    }
  }

  const [exitCode] = await exitPromise;
  if (exitCode !== 0 || !commandStarted || !noticeWritten || !transportAck || !cognitionSeen) {
    throw new Error(
      `F254 Claude capability fixture failed: ${JSON.stringify({
        exitCode,
        commandStarted,
        noticeWritten,
        transportAck,
        cognitionSeen,
        observedEventTypes: [...observedEventTypes],
        observedEvents,
        stderr: stderr.join('').slice(-500),
      })}`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({
      fixtureId,
      commandStarted,
      noticeWritten,
      transportAck,
      cognitionSeen,
      resultCountBeforeNotice,
      resultCount,
      deliverySemantics: 'queued_internal_turn',
      exactActiveTurnClaim: false,
    })}\n`,
  );
} finally {
  clearTimeout(timeout);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  await redis.del(unseenKey);
  await redis.quit();
}
