// F117 Phase M live contract: does the installed Claude Agent SDK still say when an appended input
// entered the model input? Run on every SDK upgrade: `node packages/api/scripts/f117-sdk-read-evidence-contract.mjs`.
// One real haiku call (the machine's own Claude login) in a throwaway directory, no MCP, no settings.
// It pushes an input while a tool runs and requires, for that input, in this order: a
// `command_lifecycle` frame with state `started`, a top-level non-ping model frame, and a success
// result whose `user_message_uuids` names it. Exit 0 only then.
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

const sdkVersion = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'))), 'package.json'),
    'utf8',
  ),
).version;
const cwd = mkdtempSync(join(tmpdir(), 'f117-sdk-read-contract-'));

function inputQueue() {
  const values = [];
  const waiters = [];
  let closed = false;
  return {
    push(value) {
      const waiter = waiters.shift();
      if (waiter) waiter({ value, done: false });
      else values.push(value);
    },
    close() {
      closed = true;
      for (const waiter of waiters.splice(0)) waiter({ value: undefined, done: true });
    },
    [Symbol.asyncIterator]() {
      return {
        next: () =>
          values.length
            ? Promise.resolve({ value: values.shift(), done: false })
            : closed
              ? Promise.resolve({ value: undefined, done: true })
              : new Promise((resolve) => waiters.push(resolve)),
      };
    },
  };
}

const userMessage = (uuid, text, sessionId = '') => ({
  type: 'user',
  uuid,
  session_id: sessionId,
  parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'text', text }] },
});

const first = randomUUID();
const appended = randomUUID();
const input = inputQueue();
const seen = [];
let pushed = false;
let verdict = 'no result';
const deadline = Date.now() + 120_000;
try {
  const run = query({
    prompt: input,
    options: {
      cwd,
      model: 'claude-haiku-4-5',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      settingSources: [],
      includePartialMessages: true,
    },
  });
  input.push(
    userMessage(first, 'Use the Bash tool to run exactly: sleep 6 && echo done. Then reply with one short sentence.'),
  );
  for await (const event of run) {
    if (event.type === 'command_lifecycle' && event.command_uuid === appended) seen.push(`lifecycle:${event.state}`);
    const topLevel = event.parent_tool_use_id === null || event.parent_tool_use_id === undefined;
    const modelFrame =
      topLevel && (event.type === 'assistant' || (event.type === 'stream_event' && event.event?.type !== 'ping'));
    if (modelFrame && seen.at(-1) === 'lifecycle:started') seen.push('model-frame');
    if (!pushed && event.type === 'assistant' && event.message?.content?.some((block) => block.type === 'tool_use')) {
      pushed = true;
      input.push(userMessage(appended, 'Also end your reply with the word BANANA.', event.session_id));
    }
    if (event.type === 'result') {
      const echoed = event.user_message_uuids ?? (event.user_message_uuid ? [event.user_message_uuid] : []);
      if (echoed.includes(appended)) {
        seen.push(event.is_error ? 'result:error' : 'result:echo');
        break;
      }
    }
    if (Date.now() > deadline) {
      verdict = 'timeout';
      break;
    }
  }
} finally {
  input.close();
  rmSync(cwd, { recursive: true, force: true });
}

const expected = ['lifecycle:started', 'model-frame', 'result:echo'];
const ordered = expected.every(
  (step, index) => seen.indexOf(step) >= 0 && (index === 0 || seen.indexOf(step) > seen.indexOf(expected[index - 1])),
);
if (pushed && ordered) {
  console.log(`PASS sdk ${sdkVersion}: ${seen.join(' → ')}`);
  process.exit(0);
}
console.error(`FAIL sdk ${sdkVersion} (${verdict}): pushed=${pushed} seen=${seen.join(' → ') || 'nothing'}`);
process.exit(1);
