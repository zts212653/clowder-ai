import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { acpSessionBindingSignature } from '../acp/active-session-cache.js';
import { piMcpServers } from './pi-session-mcp.js';

export interface PiSessionStorage {
  root: string;
  scope: string;
}
export interface PiSessionSlot {
  id: string;
  directory: string;
  cwd: string;
  binding: string;
  runtimeBinding?: string;
  file?: string;
}
const ID = /^clowder-pi-v1-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const piDigest = (value: string): string => createHash('sha256').update(value).digest('hex');

function directory(path: string): void {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry && (entry.isSymbolicLink() || !entry.isDirectory()))
    throw new Error('Pi session directory must not redirect');
  if (!entry) mkdirSync(path, { mode: 0o700 });
}
function regularFile(path: string): void {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Pi history must be a regular file');
}
export function piCanonicalCwd(value: unknown): string {
  if (typeof value !== 'string' || !isAbsolute(value)) throw new Error('Pi requires an absolute working directory');
  return realpathSync.native(value);
}
function binding(cwd: string, servers: unknown): string {
  const stable = piMcpServers(servers).map((server) => {
    if (
      !(server.name === 'cat-cafe' || server.name.startsWith('cat-cafe-')) ||
      !server.env.some((entry) => entry.name === 'CAT_CAFE_CREDENTIAL_FILE' && entry.value)
    )
      return server;
    return {
      ...server,
      env: server.env.map((entry) =>
        entry.name === 'CAT_CAFE_CREDENTIAL_FILE' ? { ...entry, value: 'session-refresh-file' } : entry,
      ),
    };
  });
  return piDigest(acpSessionBindingSignature(cwd, stable));
}
const runtimeBinding = (cwd: string, servers: unknown) =>
  piDigest(acpSessionBindingSignature(cwd, piMcpServers(servers)));
function header(path: string): Record<string, unknown> {
  regularFile(path);
  const fd = openSync(path, 'r');
  try {
    const buffer = Buffer.alloc(8192);
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    const end = buffer.subarray(0, size).indexOf(10);
    if (end < 0) throw new Error('Pi history has no complete session header');
    const value: unknown = JSON.parse(buffer.subarray(0, end).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Pi session header');
    return value as Record<string, unknown>;
  } finally {
    closeSync(fd);
  }
}

/** No transcript mirror: this stores only native files and a hashed Host binding beside each session. */
export class PiSessionStore {
  constructor(private readonly storage: PiSessionStorage) {
    if (!isAbsolute(storage.root) || !/^[a-f0-9]{64}$/.test(storage.scope)) throw new Error('Invalid Pi storage scope');
  }
  private scopeDirectory(): string {
    // The owner-selected root may itself be an intentional alias. Children must never redirect.
    mkdirSync(this.storage.root, { recursive: true, mode: 0o700 });
    let path = realpathSync.native(this.storage.root);
    for (const part of ['native-sessions', 'pi', 'v1', this.storage.scope]) {
      path = join(path, part);
      directory(path);
    }
    return path;
  }
  create(cwdValue: unknown, servers: unknown): PiSessionSlot {
    const cwd = piCanonicalCwd(cwdValue);
    const signature = binding(cwd, servers);
    const id = `clowder-pi-v1-${randomUUID()}`;
    const path = join(this.scopeDirectory(), id);
    mkdirSync(path, { mode: 0o700 });
    const slot = { id, directory: path, cwd, binding: signature, runtimeBinding: runtimeBinding(cwd, servers) };
    writeFileSync(join(path, 'binding.json'), JSON.stringify({ v: 1, id, cwd, binding: signature }), {
      flag: 'wx',
      mode: 0o600,
    });
    return slot;
  }
  assertBinding(slot: PiSessionSlot, cwd: unknown, servers: unknown): void {
    if (
      slot.cwd !== piCanonicalCwd(cwd) ||
      slot.binding !== binding(slot.cwd, servers) ||
      (slot.runtimeBinding && slot.runtimeBinding !== runtimeBinding(slot.cwd, servers))
    )
      throw new Error('Pi 会话的工作目录或 MCP 绑定已改变；请显式开启新会话，原历史已保留。');
  }
  load(id: unknown, cwd: unknown, servers: unknown): PiSessionSlot {
    if (typeof id !== 'string' || !ID.test(id))
      throw new Error('旧版 Pi 内置桥未保存可恢复的原生会话；请显式开启新会话，原聊天记录已保留。');
    const path = join(this.scopeDirectory(), id);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) throw new Error('Pi 原生会话文件缺失或不属于当前成员/profile；原历史已保留。');
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Pi session directory must not redirect');
    const metadata = join(path, 'binding.json');
    regularFile(metadata);
    if (lstatSync(metadata).size > 8192) throw new Error('Invalid Pi session binding');
    const value = JSON.parse(readFileSync(metadata, 'utf8')) as Record<string, unknown>;
    if (value.v !== 1 || value.id !== id || typeof value.cwd !== 'string' || typeof value.binding !== 'string')
      throw new Error('Invalid Pi session binding');
    const slot: PiSessionSlot = { id, directory: path, cwd: value.cwd, binding: value.binding };
    this.assertBinding(slot, cwd, servers);
    slot.runtimeBinding = runtimeBinding(slot.cwd, servers);
    const files = readdirSync(path).filter((name) => name.endsWith('.jsonl'));
    if (files.length !== 1) throw new Error('Pi 原生会话历史缺失或存在多个候选；不会自动新建会话。');
    slot.file = join(path, files[0] as string);
    const first = header(slot.file);
    if (first.type !== 'session' || first.version !== 3 || first.id !== id || first.cwd !== slot.cwd)
      throw new Error('Pi history identity, working directory or format does not match; history preserved');
    return slot;
  }
}

export function assertPiNativeIdentity(slot: PiSessionSlot, state: Record<string, unknown>): void {
  if (
    state.sessionId !== slot.id ||
    typeof state.sessionFile !== 'string' ||
    !isAbsolute(state.sessionFile) ||
    resolve(dirname(state.sessionFile)) !== slot.directory ||
    (slot.file && resolve(state.sessionFile) !== slot.file) ||
    state.isStreaming === true ||
    state.isCompacting === true
  )
    throw new Error('Pi did not open the exact native session; this bridge requires Pi 1.3-compatible persistent RPC');
  // Pi creates JSONL lazily. Anchor its first validated path before any prompt can write history.
  slot.file ??= resolve(state.sessionFile);
}
