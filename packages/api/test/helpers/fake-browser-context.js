import { EventEmitter } from 'node:events';

/** Minimal stand-ins for Playwright Page/BrowserContext/Browser: only what the pool and upstream use. */
export class FakePage extends EventEmitter {
  constructor(context, opener = null) {
    super();
    this.context = context;
    this.openerPage = opener;
    this.closed = false;
  }
  async opener() {
    return this.openerPage;
  }
  isClosed() {
    return this.closed;
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.context.list = this.context.list.filter((page) => page !== this);
    this.emit('close');
  }
}

/** Browser behind a persistent context; newContext() is what upstream's isolatedContext uses. */
export class FakeBrowser extends EventEmitter {
  constructor() {
    super();
    this.isolated = [];
  }
  async newContext() {
    const context = new FakeContext({ blank: false, browser: this });
    this.isolated.push(context);
    return context;
  }
}

export class FakeContext extends EventEmitter {
  constructor({ blank = true, browser } = {}) {
    super();
    this.list = [];
    this.closed = false;
    this.cookiesCleared = false;
    this.fakeBrowser = browser ?? new FakeBrowser();
    if (blank) this.list.push(new FakePage(this)); // a persistent context starts with one blank page
  }
  pages() {
    return [...this.list];
  }
  browser() {
    return this.fakeBrowser;
  }
  async newPage() {
    const page = new FakePage(this);
    this.list.push(page);
    this.emit('page', page);
    return page;
  }
  popup(opener) {
    const page = new FakePage(this, opener);
    this.list.push(page);
    this.emit('page', page);
    return page;
  }
  async clearCookies() {
    this.cookiesCleared = true;
  }
  async close() {
    this.closed = true;
    this.emit('close');
  }
}
