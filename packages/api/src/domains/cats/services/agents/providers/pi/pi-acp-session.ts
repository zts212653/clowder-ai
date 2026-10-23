import { rmSync } from 'node:fs';
import { PiAcpEvents } from './pi-acp-events.js';
import { type PiRecord, PiRpcProcess, PiRpcRequestRejectedError, record } from './pi-rpc-process.js';
import { piSessionLaunch } from './pi-session-launch.js';
import { piMcpExtension } from './pi-session-mcp.js';
import { assertPiNativeIdentity, type PiSessionSlot } from './pi-session-store.js';

type Option = { value: string; name: string };
function isUnknownModelPart(value: string): boolean {
  return value.trim().toLowerCase() === 'unknown';
}
function modelOption(value: unknown): Option | undefined {
  const model = record(value);
  return typeof model.provider === 'string' &&
    typeof model.id === 'string' &&
    model.provider.trim() !== '' &&
    model.id.trim() !== '' &&
    !isUnknownModelPart(model.provider) &&
    !isUnknownModelPart(model.id)
    ? {
        value: JSON.stringify([model.provider, model.id]),
        name: typeof model.name === 'string' ? model.name : `${model.provider}/${model.id}`,
      }
    : undefined;
}

export class PiAcpSession {
  get id(): string {
    return this.slot.id;
  }
  private readonly rpc: PiRpcProcess;
  private readonly directory?: string;
  private active?: { done: Promise<string>; cancel: () => void };
  private models: Option[] = [];
  private currentModel?: string;
  private thinking: string[] = [];
  private currentThinking?: string;
  private unavailable = false;
  get available(): boolean {
    return !this.unavailable;
  }

  constructor(
    command: string,
    args: string[],
    cwd: string,
    servers: unknown,
    private readonly update: (value: PiRecord) => void,
    readonly slot: PiSessionSlot,
  ) {
    const extension = piMcpExtension(slot.id, servers);
    this.directory = extension.directory;
    try {
      const sessionArgs = slot.file ? ['--session', slot.file] : ['--session-id', slot.id];
      const launch = piSessionLaunch(
        command,
        [...args, '--mode', 'rpc', '--session-dir', slot.directory, ...sessionArgs, ...extension.args],
        slot,
      );
      this.rpc = new PiRpcProcess(launch.command, launch.args, cwd);
      this.rpc.onEvent((event) => {
        if (event.type === '__exit') this.unavailable = true;
      });
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
    assertPiNativeIdentity(this.slot, state);
    const models = (Array.isArray(catalog.models) ? catalog.models : []).flatMap((value) => modelOption(value) ?? []);
    this.models = [...new Map(models.map((model) => [model.value, model])).values()];
    const currentModel = modelOption(state.model)?.value;
    // Pi reports unknown/unknown before a provider is selected. Do not expose
    // that sentinel as an ACP option: it cannot be selected or matched.
    this.currentModel =
      currentModel && this.models.some((model) => model.value === currentModel) ? currentModel : undefined;
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
    await this.verifyIdentity();
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
      if ('stopReason' in accepted) return await this.completedTurn(String(accepted.stopReason), events);
      if (accepted.disposition === 'handled' && !finished) {
        definitivelyIdle = true;
        throw new Error('Pi handled this command without starting a model task; send a plain task prompt');
      }
      return await this.completedTurn(await done, events);
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

  private async verifyIdentity(): Promise<void> {
    const state = await this.rpc.request('get_state');
    try {
      assertPiNativeIdentity(this.slot, state);
    } catch (error) {
      this.unavailable = true;
      await this.rpc.close();
      throw error;
    }
  }

  private async completedTurn(stopReason: string, events: PiAcpEvents): Promise<PiRecord> {
    if (stopReason !== 'cancelled') await this.verifyIdentity();
    return { stopReason, _meta: { pi: events.summary() } };
  }
}
