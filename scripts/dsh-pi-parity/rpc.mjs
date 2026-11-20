import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

export class Rpc {
  next = 0;
  pending = new Map();
  events = [];
  constructor(command, args, options, log) {
    this.log = log;
    this.child = spawn(command, args, { ...options, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    appendFileSync(log, JSON.stringify({ type: 'spawn', pid: this.child.pid, command, args, cwd: options.cwd }) + '\n');
    this.child.stderr.on('data', chunk => appendFileSync(log + '.stderr', chunk));
    this.child.on('exit', (code, signal) => {
      for (const pending of this.pending.values()) pending.reject(new Error(`child exit ${code}/${signal}`));
      this.pending.clear();
    });
    createInterface({ input: this.child.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      appendFileSync(log, JSON.stringify({ direction: 'in', time: Date.now(), message }) + '\n');
      if (message.method && message.id !== undefined) {
        this.events.push(message);
        const response = message.method === 'session/request_permission' ? { outcome: { outcome: 'cancelled' } } : {};
        this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: response }) + '\n');
      } else if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        message.error ? pending.reject(new Error(JSON.stringify(message.error))) : pending.resolve(message.result);
      } else this.events.push(message);
    });
  }
  call(method, params, timeout = 180000) {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      const message = { jsonrpc: '2.0', id, method, params };
      appendFileSync(this.log, JSON.stringify({ direction: 'out', time: Date.now(), message }) + '\n');
      this.child.stdin.write(JSON.stringify(message) + '\n');
    });
  }
  async close(sessionId) {
    if (sessionId) await this.call('session/close', { sessionId }, 15000).catch(() => {});
    this.child.stdin.end();
    const exited = await Promise.race([new Promise(resolve => this.child.once('exit', () => resolve(true))), new Promise(resolve => setTimeout(() => resolve(false), 5000))]);
    if (!exited) this.child.kill();
  }
}
