import { dirname, isAbsolute } from 'node:path';
import { z } from 'zod';
import { NodeExternalPluginProcessAdapter } from '../external-runtime/node-process-adapter.js';
import {
  type HostCompanionReply as CompanionReply,
  validateHostCompanionCommand as validateCompanionCommand,
  validateHostCompanionReply as validateCompanionReply,
} from './companion-private-wire.js';
import type {
  DesktopWindowExecutor,
  DesktopWindowFailure,
  DesktopWindowFailureReason,
  DesktopWindowHandle,
  DesktopWindowLaunch,
} from './types.js';

interface Options {
  readonly executable: string;
  readonly entrypoint: string;
  readonly timeoutMs?: number;
  readonly openTimeoutMs?: number;
  readonly onStage?: (stage: string) => void;
  readonly onFailure?: (failure: {
    phase: 'open';
    reason: 'timeout' | 'closed' | 'protocol' | 'other';
    lastStage: string | null;
  }) => void;
}
// Host opens can be retried over a long process lifetime. Share one child registry
// so each attempt does not leave another process-exit listener behind.
const desktopProcesses = new NodeExternalPluginProcessAdapter();
export class ElectronDesktopWindowExecutor implements DesktopWindowExecutor {
  constructor(private readonly options: Options) {
    if (!isAbsolute(options.executable) || !isAbsolute(options.entrypoint))
      throw new Error('desktop executable must be Host-owned');
  }

  async open(launch: DesktopWindowLaunch): Promise<DesktopWindowHandle> {
    launch.signal.throwIfAborted();
    const url = new URL(launch.url);
    if (
      url.protocol !== 'http:' ||
      !/^companion-[a-f0-9]{32}\.localhost$/.test(url.hostname) ||
      !url.port ||
      !url.pathname.startsWith('/packages/') ||
      !url.pathname.endsWith('.html') ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error('invalid desktop surface origin');
    const env: NodeJS.ProcessEnv = {};
    for (const key of [
      'HOME',
      'PATH',
      'TMPDIR',
      'TEMP',
      'TMP',
      'LANG',
      'LC_ALL',
      'DISPLAY',
      'XAUTHORITY',
      'SystemRoot',
    ]) {
      if (process.env[key] !== undefined) env[key] = process.env[key];
    }
    const child = await desktopProcesses.spawn({
      command: this.options.executable,
      args: [this.options.entrypoint],
      cwd: dirname(this.options.entrypoint),
      env,
    });
    let lastStage: string | null = null;
    let firstChildFailure: 'renderer-gone' | 'unresponsive' | 'window-closed' | null = null;
    let stageLine = '';
    child.stderr.on('data', (chunk: Buffer) => {
      const parts = chunk.toString('utf8').split('\n');
      for (const [index, part] of parts.entries()) {
        stageLine += part;
        if (index === parts.length - 1) {
          if (stageLine.length > 128) stageLine = '';
          continue;
        }
        const childFailure = /^\[desktop-runtime\] (renderer-gone|unresponsive|window-closed)$/.exec(stageLine)?.[1];
        if (childFailure && !firstChildFailure)
          firstChildFailure = childFailure as NonNullable<typeof firstChildFailure>;
        const stage =
          /^\[desktop-stage\] (kernel-started|app-ready|contract-ready|surface-loaded|bridge-requested|bridge-replied)$/.exec(
            stageLine,
          )?.[1];
        stageLine = '';
        if (!stage) continue;
        lastStage = stage;
        this.options.onStage?.(stage);
      }
    });
    let sequence = 0;
    let ended: Error | undefined;
    let buffer = Buffer.alloc(0);
    let shutdown: Promise<void> | undefined;
    const bridgeRequests = new Set<string>();
    const pending = new Map<
      number,
      { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
    >();
    const failure = (
      reason: DesktopWindowFailureReason,
      exitCode: number | null = null,
      signal: NodeJS.Signals | null = null,
    ): DesktopWindowFailure => ({ reason, exitCode, signal, pid: child.pid, lastStage });
    const finish = (error: Error, cause?: DesktopWindowFailure) => {
      if (ended) return;
      ended = error;
      launch.signal.removeEventListener('abort', onAbort);
      for (const call of pending.values()) {
        clearTimeout(call.timer);
        call.reject(error);
      }
      pending.clear();
      try {
        launch.onClosed(cause);
      } catch {
        // A Host observer cannot replace the terminal process result.
      }
    };
    const fail = (error: Error) => {
      const reason: DesktopWindowFailureReason =
        error.message === 'desktop request timeout'
          ? 'request-timeout'
          : error.message === 'desktop protocol violation' ||
              error.message === 'desktop protocol frame budget exceeded' ||
              error.message === 'invalid desktop visibility'
            ? 'protocol-violation'
            : 'connection-ended';
      finish(error, failure(reason));
      void child.terminate().catch(() => undefined);
    };
    const onAbort = () => {
      finish(new Error('desktop window ended'));
      void child.terminate().catch(() => undefined);
    };
    const reply = z
      .object({
        v: z.literal(1),
        id: z.number().int().positive(),
        ok: z.literal(true),
        value: z.union([z.null(), z.literal('visible'), z.literal('hidden')]),
      })
      .strict();
    const bridgeFrame = z
      .object({ v: z.literal(1), type: z.literal('companion'), id: z.string().uuid(), command: z.unknown() })
      .strict();
    const handleBridge = (frame: z.infer<typeof bridgeFrame>) => {
      if (bridgeRequests.has(frame.id) || bridgeRequests.size >= 16)
        throw new Error('desktop bridge request budget exceeded');
      bridgeRequests.add(frame.id);
      const operation: Promise<CompanionReply> =
        validateCompanionCommand(frame.command, launch.companionContract) && launch.request
          ? Promise.resolve().then(() => launch.request!(frame.command))
          : Promise.resolve({ kind: 'error', code: 'invalid_request' });
      void operation
        .catch(() => ({ kind: 'error', code: 'unavailable' }) as const)
        .then((result) => {
          bridgeRequests.delete(frame.id);
          if (ended) return;
          const safeReply = validateCompanionReply(result, launch.companionContract)
            ? result
            : { kind: 'error', code: 'unavailable' };
          child.stdin.write(
            `${JSON.stringify({ v: 1, type: 'companion', id: frame.id, reply: safeReply })}\n`,
            (error) => {
              if (error) fail(new Error('desktop connection ended'));
            },
          );
        });
    };
    child.stdout.on('data', (chunk: Buffer) => {
      if (ended) return;
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length) {
        const newline = buffer.indexOf(10);
        if ((newline < 0 && buffer.length > 1_600_000) || newline > 1_600_000) {
          fail(new Error('desktop protocol frame budget exceeded'));
          return;
        }
        if (newline < 0) return;
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        try {
          const value: unknown = JSON.parse(line.toString('utf8'));
          const requestFrame = bridgeFrame.safeParse(value);
          if (requestFrame.success) {
            handleBridge(requestFrame.data);
            continue;
          }
          if (line.length > 8192) throw new Error('desktop control frame too large');
          const parsed = reply.parse(value);
          const call = pending.get(parsed.id);
          if (!call) throw new Error('unknown desktop response');
          pending.delete(parsed.id);
          clearTimeout(call.timer);
          call.resolve(parsed.value);
        } catch {
          fail(new Error('desktop protocol violation'));
          return;
        }
      }
    });
    void child.exited.then((exit) =>
      finish(new Error('desktop window closed'), failure(firstChildFailure ?? 'process-exit', exit.code, exit.signal)),
    );
    launch.signal.addEventListener('abort', onAbort, { once: true });
    if (launch.signal.aborted) onAbort();
    const request = (method: string, params: unknown = null): Promise<unknown> => {
      if (ended) return Promise.reject(ended);
      if (pending.size >= 16) return Promise.reject(new Error('desktop request budget exceeded'));
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        // The first open includes a cold Electron boot and verified package asset
        // load. Keep steady-state IPC strict while giving startup its own bound.
        const deadlineMs =
          method === 'open'
            ? (this.options.openTimeoutMs ?? this.options.timeoutMs ?? 30_000)
            : (this.options.timeoutMs ?? 10_000);
        const timer = setTimeout(() => fail(new Error('desktop request timeout')), deadlineMs);
        timer.unref();
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ v: 1, id, method, params })}\n`, (error) => {
          if (error) fail(new Error('desktop connection ended'));
        });
      });
    };
    const close = (): Promise<void> => {
      shutdown ??= (async () => {
        try {
          if (!ended) await request('close');
        } catch {
          /* The child is always terminated below, including a broken IPC path. */
        } finally {
          finish(new Error('desktop window closed'));
          await child.terminate();
        }
      })();
      return shutdown;
    };
    try {
      await request('open', {
        url: launch.url,
        presentation: launch.presentation,
        ...(launch.publicCompanionV2 ? { publicCompanionV2: true } : {}),
        ...(launch.companionContract ? { companionContract: launch.companionContract } : {}),
      });
      return {
        poll: async () => {
          const state = await request('poll');
          if (state !== 'visible' && state !== 'hidden') {
            fail(new Error('invalid desktop visibility'));
            throw ended!;
          }
          return state;
        },
        show: async () => {
          await request('show');
        },
        revokeMedia: async () => {
          await request('revoke-media');
        },
        navigate: async (url) => {
          await request('navigate', { url });
        },
        close,
      };
    } catch (error) {
      await close();
      const message = error instanceof Error ? error.message : '';
      const reason =
        message === 'desktop request timeout'
          ? 'timeout'
          : message === 'desktop window closed' || message === 'desktop window ended'
            ? 'closed'
            : message === 'desktop protocol violation' || message === 'desktop protocol frame budget exceeded'
              ? 'protocol'
              : 'other';
      try {
        this.options.onFailure?.({ phase: 'open', reason, lastStage });
      } catch {
        // Diagnostics must not replace the original startup failure.
      }
      throw error;
    }
  }
}
