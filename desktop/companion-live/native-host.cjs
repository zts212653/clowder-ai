const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { mkdirSync, appendFileSync } = require('node:fs');
const { saveSyntheticAudio } = require('./synthetic-audio.cjs');
const { resolve } = require('node:path');
const { EventEmitter } = require('node:events');

class NativeHost extends EventEmitter {
  constructor({ storage, memoryEntry, node, allowHomeReads = false, sourceRoot }) {
    super();
    this.storage = storage;
    this.memoryEntry = memoryEntry;
    this.node = node;
    this.allowHomeReads = allowHomeReads;
    this.sourceRoot = sourceRoot;
    this.sequence = 0;
    this.pending = new Map();
    this.child = null;
    mkdirSync(storage, { recursive: true });
    this.logPath = resolve(storage, `events-${Date.now()}.jsonl`);
  }
  record(event) {
    if (event.type === 'answer') return;
    const text = JSON.stringify({ at: new Date().toISOString(), ...event });
    if (text.length <= 100000) appendFileSync(this.logPath, `${text}\n`, { mode: 0o600 });
  }
  launch() {
    if (this.child) throw new Error('Voice session already running');
    const env = {};
    for (const key of ['HOME', 'PATH', 'TMPDIR', 'LANG', 'USER', 'SHELL'])
      if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, {
      F317_SESSION_DIR: this.storage,
      F317_MEMORY_MCP: this.memoryEntry,
      F317_ALLOW_HOME_READS: this.allowHomeReads ? '1' : '0',
      REDIS_URL: 'redis://localhost:6398',
      NODE_ENV: 'development',
    });
    if (this.sourceRoot) env.F317_SOURCE_REPO = this.sourceRoot;
    const root = resolve(__dirname, '../..');
    this.abort = new AbortController();
    const child = spawn(
      this.node,
      ['--import', resolve(root, 'packages/api/node_modules/tsx/dist/loader.mjs'), resolve(__dirname, 'bridge.ts')],
      { cwd: root, env, signal: this.abort.signal, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.child = child;
    this.record({
      type: 'launch',
      microphoneCaptured: false,
      memoryTools: this.storage.endsWith('/synthetic-safe')
        ? 'synthetic-file-only'
        : this.allowHomeReads
          ? 'feature-and-f317-docs-only'
          : 'disabled',
    });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (this.child !== child) return;
      this.record(event);
      if (event.id && this.pending.has(event.id)) {
        const waiter = this.pending.get(event.id);
        this.pending.delete(event.id);
        clearTimeout(waiter.timer);
        event.ok ? waiter.resolve(event) : waiter.reject(new Error(event.error || 'Native session failed'));
      }
      if (event.type) this.emit('event', event);
    });
    child.stderr.on('data', (bytes) => {
      const text = bytes
        .toString()
        .replace(/Bearer\s+\S+|\bsk-[\w-]+|\beyJ[\w.-]+/gi, '[redacted]')
        .slice(0, 2000);
      this.record({ type: 'diagnostic', text });
    });
    const failed = (reason) => {
      if (this.child !== child) return;
      this.child = null;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(reason));
      }
      this.pending.clear();
      this.emit('event', { type: 'closed', reason });
    };
    child.on('error', (error) => failed(error.message));
    child.on('exit', (code, signal) => {
      this.record({ type: 'bridge-exit', code, signal });
      failed(`Native session closed (${code ?? signal})`);
    });
  }
  request(method, data = {}) {
    if (!this.child) return Promise.reject(new Error('Native session is not running'));
    const id = ++this.sequence;
    return new Promise((resolveDone, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('连接超时，请重试'));
      }, 60000);
      this.pending.set(id, { resolve: resolveDone, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, ...data })}\n`);
    });
  }
  async stop() {
    if (!this.child) return;
    const ownedBridge = this.child;
    const cancellation = this.abort;
    const exited = new Promise((resolveDone) => ownedBridge.once('exit', resolveDone));
    const timer = setTimeout(() => cancellation.abort(), 4000);
    try {
      await this.request('stop');
      await exited;
    } finally {
      clearTimeout(timer);
      if (ownedBridge.exitCode === null) cancellation.abort();
    }
  }
  saveSyntheticAudio(base64) {
    saveSyntheticAudio(this.storage, base64);
  }
}
module.exports = { NativeHost };
