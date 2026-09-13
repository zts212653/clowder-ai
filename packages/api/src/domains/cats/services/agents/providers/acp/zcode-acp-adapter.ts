/**
 * ACP v1 stdio adapter over ZCode's private app-server protocol.
 * Stdout is ACP JSON-RPC only. Native frames never include a `jsonrpc` field.
 */
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { NativeAppServer } from './zcode-acp-native.js';
import {
  extractZcodeFailure,
  flattenAcpPrompt,
  formatZcodeTurnFailure,
  type JsonRpc,
  parseTurnEvent,
  readZcodeEnvModel,
  readZcodeSessionId,
  sanitizeZcodeFailureText,
  type TurnEvent,
  zcodeLaunchPlan,
  zcodeWorkspace,
} from './zcode-acp-protocol.js';

export { flattenAcpPrompt, zcodeLaunchPlan };

function acpWrite(payload: unknown): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function acpResult(id: number | string | undefined, result: unknown): void {
  if (id === undefined) return;
  acpWrite({ jsonrpc: '2.0', id, result });
}

function acpError(id: number | string | undefined, code: number, message: string): void {
  if (id === undefined) return;
  acpWrite({ jsonrpc: '2.0', id, error: { code, message: sanitizeZcodeFailureText(message) } });
}

function requestTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = Number(env.ZCODE_REQUEST_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 120_000;
}

export async function runZcodeAcpAdapter(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const bin = env.ZCODE_BIN?.trim();
  if (!bin) {
    throw new Error('ZCODE_BIN must point at zcode.cjs or the zcode CLI');
  }
  const native = new NativeAppServer(bin, env);
  const sessions = new Map<string, string>();
  // Bumped on every session/cancel. The -32031 recovery window (setModel await
  // + resend) has no active native turn, so native session/stop is a no-op
  // there; the generation check is the only guard against resending a prompt
  // the client already cancelled.
  const cancelGenerations = new Map<string, number>();
  const inflight = new Set<Promise<void>>();
  const timeoutMs = requestTimeoutMs(env);
  const shutdown = (): void => {
    native.close();
    const done = (): void => {
      process.exit(0);
    };
    const timer = setTimeout(done, 4000);
    void native.whenExited().then(() => {
      clearTimeout(timer);
      done();
    });
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let msg: JsonRpc;
    try {
      msg = JSON.parse(trimmed) as JsonRpc;
    } catch {
      continue;
    }
    const task = handleAcp(native, sessions, cancelGenerations, env, msg, timeoutMs).catch((err) => {
      acpError(msg.id, -32603, formatZcodeTurnFailure(extractZcodeFailure(err)));
    });
    inflight.add(task);
    void task.finally(() => inflight.delete(task));
  }
  await Promise.all([...inflight]);
  process.removeListener('SIGTERM', shutdown);
  process.removeListener('SIGINT', shutdown);
  native.close();
}

async function handleAcp(
  native: NativeAppServer,
  sessions: Map<string, string>,
  cancelGenerations: Map<string, number>,
  env: NodeJS.ProcessEnv,
  msg: JsonRpc,
  timeoutMs: number,
): Promise<void> {
  switch (msg.method) {
    case undefined:
      return;
    case 'initialize':
      acpResult(msg.id, {
        protocolVersion: 1,
        authMethods: [],
        agentInfo: { name: 'zcode-acp-adapter', title: 'ZCode', version: '0.16' },
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false, audio: false, embeddedContext: false },
        },
      });
      return;
    case 'session/new':
      return handleSessionNew(native, sessions, msg, timeoutMs);
    case 'session/load':
      return handleSessionLoad(native, sessions, msg, timeoutMs);
    case 'session/prompt':
      return handleSessionPrompt(native, sessions, cancelGenerations, env, msg, timeoutMs);
    case 'session/cancel': {
      const params = (msg.params ?? {}) as { sessionId?: string };
      if (params.sessionId) {
        cancelGenerations.set(params.sessionId, (cancelGenerations.get(params.sessionId) ?? 0) + 1);
        await native.request('session/stop', { sessionId: params.sessionId }, timeoutMs);
      }
      return;
    }
    default:
      acpError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

async function handleSessionNew(
  native: NativeAppServer,
  sessions: Map<string, string>,
  msg: JsonRpc,
  timeoutMs: number,
): Promise<void> {
  const params = (msg.params ?? {}) as { cwd?: string };
  const cwd = params.cwd || process.cwd();
  const created = await native.request(
    'session/create',
    {
      workspace: zcodeWorkspace(cwd),
      mode: 'yolo',
      persistence: 'immediate',
    },
    timeoutMs,
  );
  if (created.error) {
    acpError(msg.id, -32603, formatZcodeTurnFailure(extractZcodeFailure(created.error)));
    return;
  }
  const sessionId = readZcodeSessionId(created.result);
  if (!sessionId) {
    acpError(msg.id, -32603, 'zcode session/create missing sessionId');
    return;
  }
  if (!(await subscribeSession(native, sessionId, msg.id, timeoutMs))) return;
  sessions.set(sessionId, sessionId);
  acpResult(msg.id, { sessionId });
}

async function handleSessionLoad(
  native: NativeAppServer,
  sessions: Map<string, string>,
  msg: JsonRpc,
  timeoutMs: number,
): Promise<void> {
  const params = (msg.params ?? {}) as { sessionId?: string; cwd?: string };
  const sessionId = params.sessionId?.trim();
  if (!sessionId) {
    acpError(msg.id, -32602, 'session/load requires sessionId');
    return;
  }
  const cwd = params.cwd || process.cwd();
  const resumed = await native.request(
    'session/resume',
    {
      sessionId,
      workspace: zcodeWorkspace(cwd),
    },
    timeoutMs,
  );
  if (resumed.error) {
    acpError(msg.id, -32603, formatZcodeTurnFailure(extractZcodeFailure(resumed.error)));
    return;
  }
  if (!(await subscribeSession(native, sessionId, msg.id, timeoutMs))) return;
  sessions.set(sessionId, sessionId);
  acpResult(msg.id, { sessionId });
}

async function subscribeSession(
  native: NativeAppServer,
  sessionId: string,
  acpId: number | string | undefined,
  timeoutMs: number,
): Promise<boolean> {
  const sub = await native.request(
    'session/subscribe',
    {
      sessionId,
      deliveryKind: 'desktop-continuous',
      includeSnapshot: true,
      afterSeq: 0,
    },
    timeoutMs,
  );
  if (sub.error) {
    acpError(acpId, -32603, formatZcodeTurnFailure(extractZcodeFailure(sub.error)));
    return false;
  }
  return true;
}

/**
 * ZCode 0.16.3 cold-resumes sessions with a deferred model adapter; if the
 * workspace provider registry has not (re)registered the session's model by
 * the time the first prompt lands, session/send fails with -32031
 * (ZCODE_RUNTIME_MODEL_UNAVAILABLE, "历史任务使用的模型已不可用"). Headless ACP
 * clients cannot answer the interactive model-picker, so re-register the
 * env-configured model via session/setModel and retry the send once.
 */
function isRuntimeModelUnavailable(error: unknown): boolean {
  const failure = extractZcodeFailure(error);
  const code = String(failure.code ?? '');
  return code === '32031' || code === '-32031';
}

function zcodeEnvRuntimeModel(env: NodeJS.ProcessEnv) {
  const modelId = readZcodeEnvModel(env.ZCODE_MODEL);
  if (!modelId) return undefined;
  const model = { providerId: 'anthropic', modelId };
  return {
    model,
    runtimeModel: {
      model,
      revision: `hub-env:${modelId}`,
      generatedAt: Date.now(),
      provider: { providerId: 'anthropic', kind: 'anthropic', models: [{ modelId }] },
    },
  };
}

async function recoverRuntimeModel(
  native: NativeAppServer,
  sessionId: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<boolean> {
  const payload = zcodeEnvRuntimeModel(env);
  if (!payload) return false;
  const set = await native.request('session/setModel', { sessionId, ...payload }, timeoutMs);
  if (set.error) {
    process.stderr.write(
      `[zcode-acp-adapter] -32031 recovery via session/setModel failed: ${sanitizeZcodeFailureText(
        formatZcodeTurnFailure(extractZcodeFailure(set.error)),
      )}\n`,
    );
    return false;
  }
  return true;
}

async function handleSessionPrompt(
  native: NativeAppServer,
  sessions: Map<string, string>,
  cancelGenerations: Map<string, number>,
  env: NodeJS.ProcessEnv,
  msg: JsonRpc,
  timeoutMs: number,
): Promise<void> {
  const params = (msg.params ?? {}) as { sessionId?: string; prompt?: unknown };
  const sessionId = params.sessionId;
  if (!sessionId || !sessions.has(sessionId)) {
    acpError(msg.id, -32602, 'unknown sessionId');
    return;
  }
  const cancelGenerationAtStart = cancelGenerations.get(sessionId) ?? 0;
  const cancelledSinceStart = (): boolean => (cancelGenerations.get(sessionId) ?? 0) !== cancelGenerationAtStart;
  const waiter = waitForTurn(native, sessionId, (delta) => {
    acpWrite({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: delta } },
      },
    });
  });
  try {
    let sent = await native.request('session/send', { sessionId, content: flattenAcpPrompt(params.prompt) }, timeoutMs);
    if (sent.error && isRuntimeModelUnavailable(sent.error)) {
      // A cancel that landed while the first send was in flight (or during
      // recovery) settles as cancelled, never as a surfaced -32031 failure.
      if (
        !cancelledSinceStart() &&
        (await recoverRuntimeModel(native, sessionId, env, timeoutMs)) &&
        !cancelledSinceStart()
      ) {
        sent = await native.request('session/send', { sessionId, content: flattenAcpPrompt(params.prompt) }, timeoutMs);
      }
      if (cancelledSinceStart()) {
        acpResult(msg.id, { stopReason: 'cancelled' });
        return;
      }
    }
    if (sent.error) {
      acpError(msg.id, -32603, formatZcodeTurnFailure(extractZcodeFailure(sent.error)));
      return;
    }
    const outcome = await waiter.promise;
    if (outcome.terminal === 'failed') {
      acpError(msg.id, -32603, formatZcodeTurnFailure(outcome.failure));
      return;
    }
    acpResult(msg.id, { stopReason: outcome.terminal === 'cancelled' ? 'cancelled' : 'end_turn' });
  } catch (err) {
    acpError(msg.id, -32603, formatZcodeTurnFailure(extractZcodeFailure(err)));
  } finally {
    waiter.dispose();
  }
}

function waitForTurn(
  native: NativeAppServer,
  sessionId: string,
  onDelta: (text: string) => void,
): { promise: Promise<TurnEvent>; dispose: () => void } {
  let disposed = false;
  let stopEvent = (): void => {};
  let stopClose = (): void => {};
  const promise = new Promise<TurnEvent>((resolve) => {
    const finish = (event: TurnEvent): void => {
      if (disposed) return;
      disposed = true;
      stopEvent();
      stopClose();
      resolve(event);
    };
    stopEvent = native.onEvent((msg) => {
      const event = parseTurnEvent(msg, sessionId);
      if (!event) return;
      if (event.delta) onDelta(event.delta);
      if (event.terminal) finish(event);
    });
    stopClose = native.onClose((reason) => {
      finish({ terminal: 'failed', failure: { code: 'native_exit', message: reason } });
    });
  });
  return {
    promise,
    dispose: () => {
      disposed = true;
      stopEvent();
      stopClose();
    },
  };
}

const isMain = Boolean(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);
if (isMain) {
  runZcodeAcpAdapter().catch((err) => {
    process.stderr.write(`${sanitizeZcodeFailureText(formatZcodeTurnFailure(extractZcodeFailure(err)))}\n`);
    process.exit(1);
  });
}
