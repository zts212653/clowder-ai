import { constants, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AgentMessage } from '../../../../types.js';
import type { AgyStreamJsonEvent } from '../../agy-stream-json-parser.js';

const MAX_SPILL_BYTES = 8 * 1024 * 1024;

function unsafeOutput(): Error {
  return new Error('Native tool result unconfirmed: the step output file could not be read safely.');
}

function assertRegularOutput(stat: Stats): void {
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_SPILL_BYTES) throw unsafeOutput();
}

function sameFile(left: Stats, right: Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Read one bounded regular file; never follow a carrier-supplied URI or a redirected directory. */
async function readStepOutput(path: string): Promise<string | undefined> {
  const parent = dirname(path);
  let entry: Stats;
  try {
    if ((await realpath(parent)) !== parent) throw unsafeOutput();
    entry = await lstat(path);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw unsafeOutput();
  }
  assertRegularOutput(entry);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => {
    throw unsafeOutput();
  });
  try {
    const before = await file.stat();
    assertRegularOutput(before);
    if (!sameFile(entry, before)) throw unsafeOutput();
    // One extra byte detects growth without allocating or reading an unbounded file.
    const bytes = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat();
    const current = await lstat(path);
    assertRegularOutput(current);
    if (
      length !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      !sameFile(before, current) ||
      (await realpath(parent)) !== parent
    )
      throw unsafeOutput();
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length));
  } catch {
    throw unsafeOutput();
  } finally {
    await file.close();
  }
}

/** Official CLI 1.4.6 can omit large MCP output while retaining this exact step's output.txt.
 * Enrich only a validated live result. Raw protocol evidence and terminal authority stay unchanged.
 */
export async function recoverAgyNativeMcpSpill(
  message: AgentMessage,
  event: Extract<AgyStreamJsonEvent, { kind: 'step' }>,
  profileHome: string,
  declaredNativeTools: readonly string[],
): Promise<AgentMessage> {
  const sessionId = message.metadata?.sessionId;
  if (
    message.type !== 'tool_result' ||
    message.toolSource !== 'mcp' ||
    message.toolResultStatus !== 'ok' ||
    message.content !== '' ||
    !message.toolName?.startsWith('mcp:') ||
    !declaredNativeTools.includes('call_mcp_tool') ||
    event.toolName !== 'call_mcp_tool' ||
    event.state !== 'DONE' ||
    event.toolOutput !== null ||
    !sessionId ||
    event.conversationId !== sessionId ||
    message.toolUseId !== `${sessionId}:${event.stepIndex}`
  )
    return message;
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sessionId) ||
    !Number.isSafeInteger(event.stepIndex) ||
    event.stepIndex < 0
  )
    throw unsafeOutput();
  const path = join(
    profileHome,
    '.gemini/antigravity-cli/brain',
    sessionId,
    '.system_generated/steps',
    String(event.stepIndex),
    'output.txt',
  );
  const content = await readStepOutput(path);
  return content === undefined ? message : { ...message, content };
}
