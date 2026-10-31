import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCodexAppServerInitializedRpc } from '../src/domains/cats/services/agents/providers/CodexAppServerNativeRpc.js';
import { inspectCodexImportSession } from '../src/domains/cats/services/agents/providers/CodexLocalSessionSource.js';
import { createDirectAgentCarrierSession } from '../src/domains/cats/services/agents/providers/DirectAgentCarrierSession.js';

const cwd = await mkdtemp(join(tmpdir(), 'f322-native-import-'));
const options = {
  command: 'codex',
  args: ['app-server', '--stdio'],
  cwd,
  env: { NODE_OPTIONS: null },
  invocationId: 'f322-native-import-acceptance',
};
const owner = await createDirectAgentCarrierSession(options);
const evidence: Record<string, unknown> = { cwd };
let id = '';
let turnDone!: () => void;
const completed = new Promise<void>((resolve) => {
  turnDone = resolve;
});
await runCodexAppServerInitializedRpc({
  wire: owner,
  timeoutMs: 60000,
  onNotification: (message) => {
    if (message.method === 'turn/completed') turnDone();
  },
  run: async (client) => {
    const raw = await client.request('thread/start', {
      cwd,
      model: 'gpt-6.1-sol',
      ephemeral: false,
      approvalPolicy: 'never',
      sandbox: 'read-only',
      baseInstructions:
        'This is an exact-session-adoption test. Do not use tools. Follow the requested one-line response.',
    });
    id = (raw as { thread: { id: string } }).thread.id;
    evidence.sessionId = id;
    await client.request('turn/start', {
      threadId: id,
      input: [{ type: 'text', text: 'Remember the code word F322-SOL-SNAPSHOT. Reply exactly READY.' }],
    });
    await completed;
    const other = await createDirectAgentCarrierSession({ ...options, invocationId: 'f322-conflicting-import' });
    try {
      await runCodexAppServerInitializedRpc({
        wire: other,
        timeoutMs: 10000,
        run: (c) => inspectCodexImportSession(c, id),
      });
      throw new Error('Expected a live writer conflict');
    } catch (error) {
      console.error(error instanceof Error ? error.message : error);
      assert.equal((error as { code?: string }).code, 'SESSION_ACTIVE_WRITER');
      evidence.lockBlocked = true;
    }
    return null;
  },
});
const unlocked = await createDirectAgentCarrierSession({ ...options, invocationId: 'f322-unlocked-import' });
const metadata = await runCodexAppServerInitializedRpc({
  wire: unlocked,
  timeoutMs: 10000,
  run: (c) => inspectCodexImportSession(c, id),
});
assert.equal(metadata.sessionId, id);
assert.equal(metadata.projectPath, await realpath(cwd));
evidence.exactResumeAfterClose = true;
console.log(JSON.stringify(evidence));
