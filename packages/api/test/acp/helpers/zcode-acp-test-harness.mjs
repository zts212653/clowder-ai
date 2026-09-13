import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const adapterPath = join(
  __dirname,
  '../../../dist/domains/cats/services/agents/providers/acp/zcode-acp-adapter.js',
);
export const fakeBin = join(__dirname, 'fake-zcode-app-server.mjs');

export function startAdapter(dir, extraEnv = {}) {
  const isolatedHome = join(dir, 'isolated-home');
  const stderrChunks = [];
  const child = spawn(process.execPath, [adapterPath], {
    cwd: dir,
    env: {
      ...process.env,
      ZCODE_BIN: fakeBin,
      ZCODE_FAKE_STORE: join(dir, 'store.json'),
      ZCODE_FAKE_LOG: join(dir, 'rpc.log'),
      CAT_CAFE_ZCODE_HOME: isolatedHome,
      ZCODE_MODEL: 'GLM-5.2',
      NO_COLOR: '1',
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (buf) => {
    stderrChunks.push(buf.toString());
  });
  const pending = new Map();
  const updates = [];
  const rl = createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (msg.method === 'session/update') {
      updates.push(msg);
      return;
    }
    if (msg.id != null && pending.has(String(msg.id))) {
      pending.get(String(msg.id))(msg);
      pending.delete(String(msg.id));
    }
  });
  let nextId = 1;
  function request(method, params, timeoutMs = 8000) {
    const id = nextId++;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout ${method}`)), timeoutMs);
      pending.set(String(id), (msg) => {
        clearTimeout(timer);
        resolve(msg);
      });
    });
  }
  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }
  function rpcLog() {
    try {
      return readFileSync(join(dir, 'rpc.log'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }
  return {
    child,
    request,
    notify,
    updates,
    rpcLog,
    isolatedHome,
    stderr: () => stderrChunks.join(''),
  };
}

export function assistantText(updates, sessionId) {
  return updates
    .filter((u) => u.params?.sessionId === sessionId)
    .map((u) => u.params?.update?.content?.text)
    .filter((text) => typeof text === 'string')
    .join('');
}
