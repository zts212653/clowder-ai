import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PiAcpEvents } from './pi-acp-events.js';
import { type PiRecord, PiRpcProcess, PiRpcRequestRejectedError, record } from './pi-rpc-process.js';

type Option = { value: string; name: string };
function modelOption(value: unknown): Option | undefined {
  const model = record(value);
  return typeof model.provider === 'string' && typeof model.id === 'string'
    ? {
        value: JSON.stringify([model.provider, model.id]),
        name: typeof model.name === 'string' ? model.name : `${model.provider}/${model.id}`,
      }
    : undefined;
}

/** Session-only MCP registrations; never edit the user's Pi agent directory or project config. */
function mcpExtension(servers: unknown): { directory?: string; args: string[] } {
  if (!Array.isArray(servers) || servers.length === 0) return { args: [] };
  const prefix = `clowder-${randomUUID().slice(0, 8)}-`;
  const registrations = servers.map((value) => {
    const server = record(value);
    if (
      typeof server.name !== 'string' ||
      typeof server.command !== 'string' ||
      !Array.isArray(server.args) ||
      !server.args.every((arg) => typeof arg === 'string') ||
      server.type === 'http' ||
      server.type === 'sse'
    )
      throw new Error('The Pi bridge supports stdio MCP servers only');
    const env = Object.fromEntries(
      (Array.isArray(server.env) ? server.env : []).map((item) => {
        const entry = record(item);
        if (typeof entry.name !== 'string' || typeof entry.value !== 'string')
          throw new Error('Invalid Pi MCP environment');
        return [entry.name, entry.value];
      }),
    );
    return [
      prefix + server.name.replace(/[^A-Za-z0-9_-]/g, '_'),
      { command: server.command, args: server.args, env, exposure: 'direct' },
    ];
  });
  const directory = mkdtempSync(join(tmpdir(), 'clowder-pi-mcp-'));
  const entry = join(directory, 'session-mcp.mjs');
  try {
    writeFileSync(
      entry,
      `export default function(pi) { for (const [name, config] of ${JSON.stringify(registrations)}) pi.registerMcpServer(name, config); }\n`,
      { mode: 0o600 },
    );
    return { directory, args: ['--extension', entry] };
  } catch (error) {
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export class PiAcpSession {
  readonly id = randomUUID();
  private readonly rpc: PiRpcProcess;
  private readonly directory?: string;
  private active?: { done: Promise<string>; cancel: () => void };
  private models: Option[] = [];
  private currentModel?: string;
  private thinking: string[] = [];
  private currentThinking?: string;
  private unavailable = false;

  constructor(
    command: string,
    args: string[],
    cwd: string,
    servers: unknown,
    private readonly update: (value: PiRecord) => void,
  ) {
    const extension = mcpExtension(servers);
    this.directory = extension.directory;
    try {
      this.rpc = new PiRpcProcess(command, [...args, '--mode', 'rpc', '--no-session', ...extension.args], cwd);
    } catch (error) {
      if (this.directory) rmSync(this.directory, { recursive: true, force: true });
      throw error;
    }
  }

  async describe(): Promise<PiRecord> {
    this.ensureAvailable();
    const [state, catalog, thinking] = await Promise.all([
      this.rpc.request('get_state'),
      this.rpc.request('get_available_models'),
      this.rpc.request('get_available_thinking_levels'),
    ]);
    this.models = (Array.isArray(catalog.models) ? catalog.models : []).flatMap((value) => modelOption(value) ?? []);
    this.currentModel = modelOption(state.model)?.value;
    this.thinking = (Array.isArray(thinking.levels) ? thinking.levels : []).filter(
      (value): value is string => typeof value === 'string',
    );
    this.currentThinking = typeof state.thinkingLevel === 'string' ? state.thinkingLevel : undefined;
    return {
      sessionId: this.id,
      configOptions: [
        ...(this.currentModel
          ? [
              {
                id: 'model',
                name: 'Pi model',
                category: 'model',
                type: 'select',
                currentValue: this.currentModel,
                options: this.models,
              },
            ]
          : []),
        ...(this.currentThinking && this.thinking.length
          ? [
              {
                id: 'thought_level',
                name: 'Thinking',
                category: 'thought_level',
                type: 'select',
                currentValue: this.currentThinking,
                options: this.thinking.map((value) => ({ value, name: value })),
              },
            ]
          : []),
      ],
    };
  }

  async setOption(id: unknown, value: unknown): Promise<PiRecord> {
    this.ensureAvailable();
    if (this.active) throw new Error('Pi is still completing the previous prompt');
    if (id === 'model' && typeof value === 'string' && this.models.some((model) => model.value === value)) {
      const [provider, modelId] = JSON.parse(value) as string[];
      // Official RPC set_model calls session.setModel with persist=false (the default).
      await this.rpc.request('set_model', { provider, modelId });
    } else if (id === 'thought_level' && typeof value === 'string' && this.thinking.includes(value)) {
      await this.rpc.request('set_thinking_level', { level: value });
    } else throw new Error('Pi did not advertise the requested configuration value');
    return this.describe();
  }

  async prompt(blocks: unknown): Promise<PiRecord> {
    this.ensureAvailable();
    if (this.active) throw new Error('Pi is still completing the previous prompt');
    if (
      !Array.isArray(blocks) ||
      blocks.some((block) => record(block).type !== 'text' || typeof record(block).text !== 'string')
    )
      throw new Error('The Pi bridge currently accepts text prompts only');
    const message = blocks.map((block) => record(block).text).join('\n');
    let cancelled = false,
      finished = false,
      definitivelyIdle = false;
    let complete: (reason: string) => void = () => {},
      fail: (error: Error) => void = () => {};
    const done = new Promise<string>((resolve, reject) => {
      complete = resolve;
      fail = reject;
    });
    const events = new PiAcpEvents((update) => this.update({ sessionId: this.id, update }));
    const unsubscribe = this.rpc.onEvent((event) => {
      events.accept(event);
      if (event.type === '__exit') {
        fail(event.error as Error);
      }
      if (event.type === 'agent_settled') {
        finished = true;
        if (cancelled || event.aborted === true) complete('cancelled');
        else if (events.failure) fail(events.failure);
        else if (!events.completedAssistant) fail(new Error('Pi settled without a completed assistant response'));
        else complete('end_turn');
      }
    });
    // Install the terminal listener before sending prompt: a fast provider may settle before admission.
    this.active = {
      done,
      cancel: () => {
        cancelled = true;
      },
    };
    try {
      const accepted = await Promise.race([
        this.rpc.request('prompt', { message }),
        done.then((stopReason) => ({ stopReason })),
      ]);
      if ('stopReason' in accepted) return { stopReason: accepted.stopReason };
      if (accepted.disposition === 'handled' && !finished) {
        definitivelyIdle = true;
        throw new Error('Pi handled this command without starting a model task; send a plain task prompt');
      }
      return { stopReason: await done };
    } catch (error) {
      if (!finished && !definitivelyIdle && !(error instanceof PiRpcRequestRejectedError)) {
        this.unavailable = true;
        await this.rpc.close();
      }
      if (cancelled) return { stopReason: 'cancelled' };
      throw error;
    } finally {
      unsubscribe();
      this.active = undefined;
    }
  }

  async cancel(): Promise<void> {
    const active = this.active;
    if (!active) return;
    active.cancel();
    try {
      await this.rpc.request('abort', {}, 3_000);
    } catch {
      await this.close();
      return;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const stopped = await Promise.race([
        active.done.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 3_000);
        }),
      ]);
      if (!stopped) await this.close();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async close(): Promise<void> {
    this.unavailable = true;
    await this.rpc.close();
    if (this.directory) rmSync(this.directory, { recursive: true, force: true });
  }

  private ensureAvailable(): void {
    if (this.unavailable) throw new Error('Pi 会话已结束，请新建会话；已有聊天记录仍保留。');
  }
}
