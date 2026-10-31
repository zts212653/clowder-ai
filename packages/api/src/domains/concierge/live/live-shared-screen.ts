import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CodexAppServerJsonObject } from '../../cats/services/agents/providers/CodexAppServerEventMapper.js';

interface Frame {
  image: string;
  width: number;
  height: number;
  observedAt: number;
  frameId: string;
  sourceLabel: string;
}
interface Context {
  request(): string;
  start(id: string, label: string): boolean;
  accept(id: string, frame: unknown): boolean;
  stop(): void;
  current(): Frame | undefined;
}
interface Broker {
  path: string;
  close(): Promise<void>;
}

/** Same frame validator and owner-only socket as the desktop spike, now scoped by the admitted Host call. */
export class LiveSharedScreen {
  private selection?: { clientId: string; localId: string };
  private closed = false;
  private constructor(
    private readonly context: Context,
    private readonly broker: Broker,
    readonly server: CodexAppServerJsonObject,
  ) {}
  static async create(desktopRoot: string, authorize: (meta: unknown) => boolean): Promise<LiveSharedScreen> {
    const require = createRequire(import.meta.url);
    const { ScreenContext } = require(join(desktopRoot, 'screen-context.cjs')) as { ScreenContext: new () => Context };
    const context = new ScreenContext();
    const module: {
      createScreenBroker(read: () => Frame | undefined, authorize: (meta: unknown) => boolean): Promise<Broker>;
    } = await import(pathToFileURL(join(desktopRoot, 'screen-broker.mjs')).href);
    const broker = await module.createScreenBroker(() => context.current(), authorize);
    return new LiveSharedScreen(context, broker, {
      enabled: true,
      required: true,
      command: process.execPath,
      args: [join(desktopRoot, 'screen-tool.mjs')],
      env: { F317_SCREEN_SOCKET: broker.path },
    });
  }
  open(clientId: string, label: string): void {
    if (this.closed || !/^[a-zA-Z0-9_-]{1,160}$/.test(clientId)) throw new Error('Invalid screen selection');
    this.stop();
    const localId = this.context.request();
    if (!this.context.start(localId, label)) throw new Error('Invalid screen source');
    this.selection = { clientId, localId };
  }
  frame(clientId: string, frame: Frame): void {
    if (
      this.closed ||
      this.selection?.clientId !== clientId ||
      !Number.isFinite(frame?.observedAt) ||
      Date.now() - frame.observedAt < 0 ||
      Date.now() - frame.observedAt > 5000 ||
      !this.context.accept(this.selection.localId, frame)
    )
      throw new Error('Shared screen grant expired');
  }
  current(): Frame | undefined {
    return this.context.current();
  }
  stop(): void {
    this.selection = undefined;
    this.context.stop();
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stop();
    await this.broker.close();
  }
}
