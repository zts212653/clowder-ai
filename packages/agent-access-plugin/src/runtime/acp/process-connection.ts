import { PassThrough, Readable } from 'node:stream';
import type { AgentAccessAcpProcessCommand, AgentAccessAcpProcessTermination } from '@clowder-ai/agent-contract/acp';
import { z } from 'zod';
import { type AcpChildConnection, AcpClient } from './AcpClient.js';

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

/** One protocol driver per process admitted by this activation's Host. */
export function createAcpProcessActions() {
  const drivers = new Map<
    string,
    { client: AcpClient; commands: Readable; initialization?: ReturnType<AcpClient['initialize']> }
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
          drivers.set(request.processId, { client, commands });
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
    stop() {
      for (const { commands } of drivers.values()) commands.destroy();
      drivers.clear();
    },
  };
}
