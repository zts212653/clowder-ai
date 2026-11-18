import { PassThrough, Readable } from 'node:stream';
import {
  type AcpMcpServer,
  type AgentAccessAcpProcessCommand,
  type AgentAccessAcpProcessTermination,
  type AgentAccessAcpSessionFailure,
  type AgentAccessAcpSessionOperation,
  type AgentAccessAcpTurnFrame,
  agentAccessAcpSessionOperationSchema,
} from '@clowder-ai/agent-contract/acp';
import { z } from 'zod';
import {
  type AcpChildConnection,
  AcpClient,
  AcpProtocolError,
  AcpSessionCancelledError,
  AcpStreamIdleError,
  AcpTimeoutError,
} from './AcpClient.js';
import { AcpSessionBindingError } from './active-session-cache.js';

/** Join a Host-started process to the plugin ACP driver without retaining callable authority. */
export function attachAcpProcessConnection(input: {
  pid?: number;
  stdout: Readable;
  stderr?: Readable;
  lifecycle: Readable;
}) {
  const commands = new PassThrough({ objectMode: true });
  let complete!: () => void;
  const completion = new Promise<void>((resolve) => {
    complete = resolve;
  });
  let outcome: AgentAccessAcpProcessTermination | undefined;
  let closeRequested = false;
  const errorListeners: Array<(error: Error) => void> = [];
  const exitListeners: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = [];
  const settle = (result: AgentAccessAcpProcessTermination) => {
    if (outcome) return;
    outcome = result;
    commands.end();
    complete();
    if (result.kind === 'error') {
      for (const listener of errorListeners) listener(new Error(result.message));
    } else {
      for (const listener of exitListeners) listener(result.code, result.signal);
    }
  };
  void (async () => {
    for await (const result of input.lifecycle as AsyncIterable<AgentAccessAcpProcessTermination>) {
      settle(result);
      return;
    }
    settle({ kind: 'error', message: 'ACP process lifecycle ended without exit proof' });
  })().catch((error: unknown) =>
    settle({ kind: 'error', message: error instanceof Error ? error.message : 'ACP process lifecycle failed' }),
  );

  function send(command: AgentAccessAcpProcessCommand) {
    commands.write(command);
  }
  const child: AcpChildConnection = {
    pid: input.pid,
    stdout: input.stdout,
    stderr: input.stderr,
    isWritable: () => !closeRequested && !outcome && !commands.destroyed,
    isKilled: () => closeRequested || outcome !== undefined,
    write(line) {
      if (closeRequested || outcome || commands.destroyed) throw new Error('ACP agent stdin is not writable');
      send({ kind: 'write', line });
    },
    onError(listener) {
      errorListeners.push(listener);
      if (outcome?.kind === 'error') listener(new Error(outcome.message));
    },
    onExit(listener) {
      exitListeners.push(listener);
      if (outcome?.kind === 'exit') listener(outcome.code, outcome.signal);
    },
    shutdown(graceMs, endStdin) {
      if (!outcome && !closeRequested && !commands.destroyed) {
        closeRequested = true;
        send({ kind: 'shutdown', graceMs, endStdin });
      }
      return completion;
    },
  };
  return { child, commands };
}

const processId = z.string().uuid();
const processRequest = z.discriminatedUnion('operation', [
  z.object({
    operation: z.literal('open'),
    processId,
    pid: z.number().int().positive().optional(),
    cwd: z.string().min(1),
    stdout: z.instanceof(Readable),
    stderr: z.instanceof(Readable).optional(),
    lifecycle: z.instanceof(Readable),
  }),
  z.object({ operation: z.literal('initialize'), processId }),
  z.object({ operation: z.literal('close'), processId }),
]);

function describeFailure(error: unknown): AgentAccessAcpSessionFailure {
  if (error instanceof AcpSessionBindingError) return { kind: 'binding', message: error.message };
  if (error instanceof AcpProtocolError)
    return {
      kind: 'protocol',
      code: error.code,
      message: error.message.slice(`ACP error ${error.code}: `.length),
      data: error.data,
    };
  if (error instanceof AcpTimeoutError) return { kind: 'timeout', method: error.method, timeoutMs: error.timeoutMs };
  if (error instanceof AcpStreamIdleError)
    return {
      kind: 'idle',
      sessionId: error.sessionId,
      idleSinceMs: error.idleSinceMs,
      eventCount: error.eventCount,
      configuredIdleStallMs: error.configuredIdleStallMs,
    };
  if (error instanceof AcpSessionCancelledError) return { kind: 'cancelled', sessionId: error.sessionId };
  return { kind: 'other', message: error instanceof Error ? error.message : String(error) };
}

interface ProcessTurn {
  contentRef: string;
  phase: 'waiting' | 'active' | 'cancelled' | 'settled';
}

async function* promptAcpProcess(
  client: AcpClient,
  request: Extract<AgentAccessAcpSessionOperation, { operation: 'prompt' }>,
  state: ProcessTurn,
): AsyncGenerator<AgentAccessAcpTurnFrame> {
  const { sessionId, contentRef, limits } = request;
  if (state.phase === 'cancelled') {
    state.phase = 'settled';
    yield {
      kind: 'terminal',
      finalResponse: false,
      cancelQueued: false,
      sessionReusable: true,
      processReusable: client.isSafeForSingleFlightReuse,
      result: { failure: { kind: 'cancelled', sessionId } },
    };
    return;
  }
  state.phase = 'active';
  let cancelQueued = false;
  const turn = client.promptStream(sessionId, contentRef, {
    ...limits,
    onCancelQueued: () => {
      cancelQueued = true;
    },
  });
  let result: Extract<AgentAccessAcpTurnFrame, { kind: 'terminal' }>['result'];
  try {
    for (let next = await turn.next(); ; next = await turn.next()) {
      if (next.done) {
        result = { stopReason: next.value };
        break;
      }
      yield { kind: 'update', update: next.value };
    }
  } catch (error) {
    result = { failure: describeFailure(error) };
  } finally {
    await turn.return('cancelled');
    state.phase = 'settled';
  }
  yield {
    kind: 'terminal',
    finalResponse: client.hasPromptFinalResponse(sessionId),
    cancelQueued,
    sessionReusable: client.isSessionSafeForReuse(sessionId),
    processReusable: client.isSafeForSingleFlightReuse,
    result,
  };
}

/** One protocol driver per process admitted by this activation's Host. */
export function createAcpProcessActions() {
  const drivers = new Map<
    string,
    {
      client: AcpClient;
      commands: Readable;
      turns: Map<string, ProcessTurn>;
      initialization?: ReturnType<AcpClient['initialize']>;
    }
  >();

  return {
    acpProcess(input: unknown) {
      const request = processRequest.parse(input);
      const current = drivers.get(request.processId);
      switch (request.operation) {
        case 'open': {
          if (current) throw new Error('ACP process is already open');
          const { child, commands } = attachAcpProcessConnection(request);
          const client = new AcpClient(
            { command: 'attached-acp', args: [], cwd: request.cwd, defaultPermissionDecision: 'reject' },
            {
              log: console,
              launch(config, captureCwdIdentity) {
                captureCwdIdentity();
                return {
                  child,
                  childEnv: {},
                  spawnLog: { command: config.command, argCount: 0, cwd: config.cwd, pid: child.pid, envKeyCount: 0 },
                };
              },
            },
          );
          client.onCapacity((signal) => {
            if (!commands.destroyed) commands.write({ kind: 'capacity', ...signal });
          });
          drivers.set(request.processId, { client, commands, turns: new Map() });
          commands.once('close', () => drivers.delete(request.processId));
          return { commands };
        }
        case 'initialize':
          if (!current) throw new Error('ACP process is unavailable in this activation');
          current.initialization ??= current.client.initialize();
          return current.initialization;
        case 'close':
          return current?.client.close();
      }
    },
    async acpSession(input: unknown) {
      const request = agentAccessAcpSessionOperationSchema.parse(input);
      const current = drivers.get(request.processId);
      if (!current?.initialization) throw new Error('ACP process is unavailable in this activation');
      await current.initialization;
      const client = current.client;
      if (request.operation === 'prompt') {
        const previous = current.turns.get(request.sessionId);
        const turn: ProcessTurn = {
          contentRef: request.contentRef,
          phase:
            previous?.contentRef === request.contentRef && previous.phase === 'cancelled' ? 'cancelled' : 'waiting',
        };
        current.turns.set(request.sessionId, turn);
        return promptAcpProcess(client, request, turn);
      }
      try {
        switch (request.operation) {
          case 'newSession':
          case 'loadSession':
          case 'resumeSession': {
            const mcp = request.mcp.map(
              ({ ref, transport }): AcpMcpServer =>
                transport === 'stdio'
                  ? { name: ref, command: 'host-stdio-reference', args: [], env: [] }
                  : { type: transport, name: ref, url: 'http://host-mcp-reference.invalid', headers: [] },
            );
            const result =
              request.operation === 'newSession'
                ? await client.newSession(request.cwd, mcp)
                : await client[request.operation](request.sessionId, request.cwd, mcp);
            return { ok: true, result };
          }
          case 'closeSession':
            await client.closeSession(request.sessionId);
            current.turns.delete(request.sessionId);
            break;
          case 'setModel':
            await client.setSessionModel(request.sessionId, request.modelId);
            break;
          case 'setConfig':
            await client.setSessionConfigOption(request.sessionId, request.configId, request.value);
            break;
          case 'cancel': {
            const turn = current.turns.get(request.sessionId);
            if (turn?.contentRef === request.contentRef) {
              if (turn.phase === 'active') return { ok: true, result: client.cancelSession(request.sessionId, true) };
              if (turn.phase === 'waiting') turn.phase = 'cancelled';
            } else if (!turn || turn.phase === 'settled') {
              current.turns.set(request.sessionId, { contentRef: request.contentRef, phase: 'cancelled' });
            }
            return { ok: true, result: false };
          }
        }
        return { ok: true };
      } catch (error) {
        return { ok: false, failure: describeFailure(error) };
      }
    },
    stop() {
      for (const { commands } of drivers.values()) commands.destroy();
      drivers.clear();
    },
  };
}
