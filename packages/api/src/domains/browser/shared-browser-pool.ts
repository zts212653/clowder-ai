/**
 * F333: one persistent browser per workspace, shared by every cat, with tabs scoped to a thread.
 *
 * Why the scoping exists: cats in the same thread hand pages to each other, while a cat in another
 * thread must not navigate or close them by accident. It is not a security boundary — Playwright's
 * `browser_run_code_unsafe` can reach `page.context()`; the callback token stays in the API instead.
 *
 * Upstream facts this relies on (@playwright/mcp 0.0.84, verified in its bundled source):
 * - `createConnection(config, contextGetter)` calls the getter on the first tool call, then adopts
 *   `context.pages()` in order and makes the first one current.
 * - Context listens for the `page` event and never closes pages it did not open in an isolated context.
 * - `browser_tabs new` + isolatedContext calls `defaultContext.browser().newContext()`, then adopts that
 *   context's pages through its own `page` listener.
 */

export interface PoolPage {
  opener(): Promise<PoolPage | null>;
  close(): Promise<void>;
  isClosed(): boolean;
  on(event: 'close', listener: () => void): unknown;
}

export interface PoolContext {
  pages(): PoolPage[];
  newPage(): Promise<PoolPage>;
  on(event: string, listener: (...args: never[]) => void): unknown;
  close(): Promise<void>;
  browser?(): unknown;
}

type PageListener = (page: PoolPage) => void;
type Emitter = { removeListener?(event: string, listener: (...args: never[]) => void): unknown };

const PAGE_EVENT_METHODS = new Set(['on', 'addListener', 'once', 'off', 'removeListener']);
const ADD_METHODS = new Set(['on', 'addListener', 'once']);
/** Upper bounds so one thread or one runaway loop cannot exhaust the shared browser. */
export const MAX_PAGES_PER_THREAD = 20;
export const MAX_PAGES_PER_BROWSER = 100;

export class WorkspaceBrowser {
  private context?: Promise<PoolContext>;
  private readonly owners = new WeakMap<PoolPage, string>();
  private readonly announced = new WeakSet<PoolPage>();
  private readonly views = new Set<ThreadView>();
  /** Open pages per thread across the default and isolated contexts, plus in-flight reservations. */
  private readonly counted = new Map<string, Set<PoolPage>>();
  private readonly reserved = new Map<string, number>();

  constructor(private readonly launch: () => Promise<PoolContext>) {}

  /** Launches lazily; a closed or failed launch is retried by the next caller. */
  ensure(): Promise<PoolContext> {
    if (!this.context) {
      const launching = this.launch().then(async (context) => {
        context.on('page', ((page: PoolPage) => void this.adopt(page)) as never);
        context.on('close', (() => {
          if (this.context === launching) this.context = undefined;
        }) as never);
        // A persistent context opens with an unowned blank page; nobody should inherit it.
        await Promise.all(context.pages().map((page) => page.close().catch(() => {})));
        return context;
      });
      launching.catch(() => {
        if (this.context === launching) this.context = undefined;
      });
      this.context = launching;
    }
    return this.context;
  }

  isRunning(): boolean {
    return this.context !== undefined;
  }

  view(threadKey: string): ThreadView {
    const view = new ThreadView(this, threadKey);
    this.views.add(view);
    return view;
  }

  release(view: ThreadView): void {
    this.views.delete(view);
  }

  async createPage(threadKey: string): Promise<PoolPage> {
    const context = await this.ensure();
    return this.openWithin(threadKey, () => context.newPage());
  }

  /**
   * Isolated contexts (`browser_tabs new` + isolatedContext) count against the same limits. Their pages
   * reach upstream through the isolated context's own `page` event, so they are never announced to
   * the thread's default-context listeners (that would list each one twice).
   */
  isolatedContext<T extends PoolContext>(context: T, threadKey: string): T {
    context.on('page', ((page: PoolPage) => void this.adopt(page, false)) as never);
    return new Proxy(context, {
      get: (target, prop) => {
        if (prop === 'newPage') return () => this.openWithin(threadKey, () => target.newPage(), false);
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  }

  /** Hard limits: a slot is reserved before the await, so concurrent opens cannot overshoot. */
  private async openWithin(threadKey: string, open: () => Promise<PoolPage>, announce = true): Promise<PoolPage> {
    if (this.threadCount(threadKey) >= MAX_PAGES_PER_THREAD)
      throw new Error(`This thread already has ${MAX_PAGES_PER_THREAD} tabs; close some with browser_tabs close.`);
    if (this.totalCount() >= MAX_PAGES_PER_BROWSER)
      throw new Error(`The shared browser already has ${MAX_PAGES_PER_BROWSER} tabs; close unused ones first.`);
    this.reserved.set(threadKey, (this.reserved.get(threadKey) ?? 0) + 1);
    try {
      const page = await open();
      if (!this.owners.has(page)) this.track(page, threadKey);
      if (announce) this.announce(page);
      return page;
    } finally {
      this.reserved.set(threadKey, (this.reserved.get(threadKey) ?? 1) - 1);
    }
  }

  private threadCount(threadKey: string): number {
    return (this.counted.get(threadKey)?.size ?? 0) + (this.reserved.get(threadKey) ?? 0);
  }

  private totalCount(): number {
    let total = 0;
    for (const thread of new Set([...this.counted.keys(), ...this.reserved.keys()])) total += this.threadCount(thread);
    return total;
  }

  private isFull(threadKey: string): boolean {
    return this.threadCount(threadKey) >= MAX_PAGES_PER_THREAD || this.totalCount() >= MAX_PAGES_PER_BROWSER;
  }

  private track(page: PoolPage, threadKey: string): void {
    this.owners.set(page, threadKey);
    // Its close event has already fired; counting it now would hold the slot forever.
    if (page.isClosed()) return;
    let pages = this.counted.get(threadKey);
    if (!pages) this.counted.set(threadKey, (pages = new Set()));
    pages.add(page);
    page.on('close', () => pages.delete(page));
  }

  async threadPages(threadKey: string): Promise<PoolPage[]> {
    if (!this.context) return [];
    const context = await this.context;
    return context.pages().filter((page) => !page.isClosed() && this.owners.get(page) === threadKey);
  }

  /** Closes this thread's pages and any page nobody owns; other threads keep theirs. */
  async closeThread(threadKey: string): Promise<number> {
    if (!this.context) return 0;
    const context = await this.context;
    const doomed = context
      .pages()
      .filter((page) => !page.isClosed() && [threadKey, undefined].includes(this.owners.get(page)));
    await Promise.all(doomed.map((page) => page.close().catch(() => {})));
    return doomed.length;
  }

  async ownedPageCount(): Promise<number> {
    return this.totalCount();
  }

  async close(): Promise<void> {
    const context = this.context;
    this.context = undefined;
    if (context) await (await context).close().catch(() => {});
  }

  ownerOf(page: PoolPage): string | undefined {
    return this.owners.get(page);
  }

  /**
   * Pages opened through openWithin are counted there (their slot was reserved before newPage), so
   * only popups are judged here: they follow their opener, and one beyond the limit is closed.
   */
  private async adopt(page: PoolPage, announce = true): Promise<void> {
    const opener = await page.opener().catch(() => null);
    if (!this.owners.has(page) && opener) {
      const owner = this.owners.get(opener);
      if (owner && this.isFull(owner)) return void page.close().catch(() => {});
      if (owner) this.track(page, owner);
    }
    if (announce && this.owners.has(page)) this.announce(page);
  }

  private announce(page: PoolPage): void {
    if (this.announced.has(page) || page.isClosed()) return;
    this.announced.add(page);
    const owner = this.owners.get(page);
    for (const view of this.views) if (view.threadKey === owner) view.emitPage(page);
  }
}

/** One MCP session's window onto its thread's pages; its own page is listed first. */
export class ThreadView {
  private ownPage?: PoolPage;
  private readonly listeners = new Map<PageListener, PageListener>();
  /** Non-page listeners upstream attached to the shared context/browser; removed on dispose. */
  private readonly attached: Array<{ target: Emitter; event: string; listener: (...args: never[]) => void }> = [];
  private real?: PoolContext;

  constructor(
    private readonly pool: WorkspaceBrowser,
    readonly threadKey: string,
  ) {}

  /** Called from the upstream contextGetter on the session's first tool call. */
  async prepare<T extends object>(): Promise<T> {
    this.real = await this.pool.ensure();
    this.ownPage = await this.pool.createPage(this.threadKey);
    return this.asContext() as T;
  }

  emitPage(page: PoolPage): void {
    for (const listener of [...this.listeners.values()]) listener(page);
  }

  /** Returns the shared context and browser to their listener baseline (Sol5.6 R1 P1-4). */
  dispose(): void {
    this.listeners.clear();
    for (const { target, event, listener } of this.attached.splice(0)) target.removeListener?.(event, listener);
    this.pool.release(this);
  }

  private asContext(): PoolContext {
    const real = this.real as PoolContext;
    const overrides: Record<string, unknown> = {
      // Own page first, so upstream makes it current instead of a page another cat is using.
      pages: () => {
        const own = this.ownPage && !this.ownPage.isClosed() ? [this.ownPage] : [];
        const thread = real
          .pages()
          .filter((page) => !page.isClosed() && page !== this.ownPage && this.pool.ownerOf(page) === this.threadKey);
        return [...own, ...thread];
      },
      newPage: () => this.pool.createPage(this.threadKey),
      // Closing the shared context would end every cat's login; a session never owns that.
      close: async () => {},
      browser: () => {
        const browser = real.browser?.() as { newContext?(...args: unknown[]): Promise<PoolContext> } | null;
        if (!browser || typeof browser !== 'object') return browser;
        return this.tracked(browser, false, {
          newContext: async (...args: unknown[]) =>
            this.pool.isolatedContext(
              await (browser.newContext as (...a: unknown[]) => Promise<PoolContext>)(...args),
              this.threadKey,
            ),
        });
      },
    };
    return this.tracked(real, true, overrides) as PoolContext;
  }

  /** Proxy that scopes `page` events (context only) and records every other listener it adds. */
  private tracked<T extends object>(target: T, scopePages: boolean, overrides: Record<string, unknown> = {}): T {
    const view = this;
    const proxy: T = new Proxy(target, {
      get(object, prop) {
        if (typeof prop === 'string' && prop in overrides) return overrides[prop];
        if (typeof prop === 'string' && PAGE_EVENT_METHODS.has(prop)) {
          const delegate = Reflect.get(object, prop, object) as (...args: unknown[]) => unknown;
          return (event: string, listener: (...args: never[]) => void) => {
            if (scopePages && event === 'page') view.scopePageListener(prop, listener as PageListener);
            else {
              delegate.call(object, event, listener);
              if (ADD_METHODS.has(prop)) view.attached.push({ target: object as Emitter, event, listener });
              else {
                const index = view.attached.findIndex(
                  (a) => a.target === object && a.event === event && a.listener === listener,
                );
                if (index >= 0) view.attached.splice(index, 1);
              }
            }
            return proxy;
          };
        }
        const value = Reflect.get(object, prop, object);
        return typeof value === 'function' ? value.bind(object) : value;
      },
    });
    return proxy;
  }

  private scopePageListener(method: string, listener: PageListener): void {
    if (method === 'off' || method === 'removeListener') this.listeners.delete(listener);
    else if (method === 'once')
      this.listeners.set(listener, (page) => {
        this.listeners.delete(listener);
        listener(page);
      });
    else this.listeners.set(listener, listener);
  }
}
