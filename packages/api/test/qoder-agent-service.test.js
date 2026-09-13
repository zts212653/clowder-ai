/**
 * F317 Phase 1 Slice 1 unit tests — 窄 QoderAgentService + runtime profile
 * 纯单测：fake spawn / 注入 fs，不真跑 qodercn。协议形状断言用 L1 夹具。
 * Slice 1 review 修正后契约：stdin prompt、init 门锁 tools/mcp/model、
 * result error 分流、exit code 终态、env 大小写+NODE_OPTIONS、路径逃逸、
 * 深层审计、account 换绑、hooks 空对象语义、default-fs 构造。
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = process.env.QODER_PARSER_SRC
  ? join(here, '..', 'src', 'domains', 'cats', 'services', 'agents', 'providers')
  : join(here, '..', 'dist', 'domains', 'cats', 'services', 'agents', 'providers');

let svcModule, profileModule, parserModule;
if (process.env.QODER_PARSER_SRC) {
  const fixed = readFileSync(join(SRC, 'QoderAgentService.ts'), 'utf8').replace(
    /from '\.\/([a-z-]+)\.js'/g,
    (m, name) => `from '${join(SRC, name + '.ts')}'`,
  );
  const tmp = join(mkdtempSync(join(tmpdir(), 'qoder-strip-')), 'QoderAgentService.ts');
  writeFileSync(tmp, fixed);
  svcModule = await import('file://' + tmp);
  profileModule = await import('file://' + join(SRC, 'qoder-runtime-profile.ts'));
  parserModule = await import('file://' + join(SRC, 'qoder-ndjson-parser.ts'));
} else {
  svcModule = await import(join(SRC, 'QoderAgentService.js'));
  profileModule = await import(join(SRC, 'qoder-runtime-profile.js'));
  parserModule = await import(join(SRC, 'qoder-ndjson-parser.js'));
}
const { buildQoderArgs, sanitizeQoderEnv, qoderInitGate, QoderAgentService } = svcModule;
const { ensureQoderRuntimeProfile, auditQoderProfile, isSafeCatIdSegment } = profileModule;
const FIXTURE = join(here, 'fixtures', 'qoder');
const fixtureLines = (name) =>
  readFileSync(join(FIXTURE, 'current', `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean);

const CAT = 'cat_test_qoder';

// ── argv：prompt 走 stdin，安全 flag 全集 ───────────────────────────────────
test('buildQoderArgs: stdin prompt channel, no prompt text in argv, full safety set', () => {
  const args = buildQoderArgs({ profileDir: '/p', model: 'qwen-max' });
  assert.deepEqual(args, [
    '-p',
    '-',
    '-m',
    'qwen-max',
    '-o',
    'stream-json',
    '--config-dir',
    '/p',
    '--strict-mcp-config',
    '--allowed-mcp-server-names',
    'nothing',
    '--tools',
    '',
    '--setting-sources',
    'user',
  ]);
  const resume = buildQoderArgs({ profileDir: '/p', model: 'qwen-max', sessionId: 'sid-1' });
  assert.ok(resume.includes('-r') && resume.includes('sid-1'));
  assert.ok(!args.join(' ').includes('bypass_permissions'));
});

// ── env：大小写归一 + Node/Dyld 注入拒绝 ───────────────────────────────────
test('sanitizeQoderEnv: case-insensitive qoder strip + denied injection keys', () => {
  const env = sanitizeQoderEnv({
    PATH: '/bin',
    QODERCN_CONFIG_DIR: '/evil',
    qodercn_config_dir: '/evil',
    Qoder_Config_Dir: '/evil',
    NODE_OPTIONS: '--require /evil.js',
    DYLD_INSERT_LIBRARIES: '/evil.dylib',
    SAFE: '1',
  });
  assert.equal(env.SAFE, '1');
  assert.equal(env.PATH, '/bin');
  for (const k of [
    'QODERCN_CONFIG_DIR',
    'qodercn_config_dir',
    'Qoder_Config_Dir',
    'NODE_OPTIONS',
    'DYLD_INSERT_LIBRARIES',
  ]) {
    assert.equal(env[k], undefined, k);
  }
});

// ── init 门：tools/mcp/model/版本 全锁 ─────────────────────────────────────
test('qoderInitGate: version, permissionMode, tools, mcp, model all enforced (missing fields red)', () => {
  const good = { protocol_version: '1.4.0', permissionMode: 'default', model: 'qwen-max', tools: [], mcp_servers: [] };
  assert.equal(qoderInitGate(good, 'qwen-max').ok, true);
  assert.equal(qoderInitGate({ ...good, protocol_version: '2.0' }, 'qwen-max').ok, false);
  assert.equal(qoderInitGate({ ...good, permissionMode: 'bypass_permissions' }, 'qwen-max').ok, false);
  assert.equal(
    qoderInitGate({ ...good, tools: ['Bash', 'Write'] }, 'qwen-max').ok,
    false,
    'full tool surface must not pass',
  );
  assert.equal(qoderInitGate({ ...good, mcp_servers: [{ name: 'x', status: 'connected' }] }, 'qwen-max').ok, false);
  // round-2 P1-1：字段缺失（undefined）不得当空数组放行
  const noTools = { ...good };
  delete noTools.tools;
  assert.equal(qoderInitGate(noTools, 'qwen-max').ok, false, 'missing tools field red');
  const noMcp = { ...good };
  delete noMcp.mcp_servers;
  assert.equal(qoderInitGate(noMcp, 'qwen-max').ok, false, 'missing mcp_servers field red');
  assert.equal(qoderInitGate({ ...good, model: 'Auto' }, 'qwen-max').ok, false, 'silent Auto fallback red');
});

test('argv carries explicit -m model (round-2 P1-1: model is a typed input, actually sent)', () => {
  const args = buildQoderArgs({ profileDir: '/p', model: 'qwen-max' });
  const i = args.indexOf('-m');
  assert.ok(i > 0 && args[i + 1] === 'qwen-max');
});

// ── profile：路径逃逸 / 深度盲区 / hooks 语义 / fail-closed ───────────────
test('isSafeCatIdSegment rejects traversal segments', () => {
  assert.equal(isSafeCatIdSegment('cat_ok-1'), true);
  assert.equal(isSafeCatIdSegment('../../victim'), false);
  assert.equal(isSafeCatIdSegment('a/b'), false);
  assert.equal(isSafeCatIdSegment('..'), false);
  assert.throws(() =>
    ensureQoderRuntimeProfile({ dataRoot: '/tmp/x', catId: '../../victim', authSourceDir: '/tmp/x' }),
  );
});

function memFs(files, unreadableDirs = new Set()) {
  const norm = (p) => p.replace(/\/+$/, '');
  const fs = {
    files,
    existsSync: (p) => files.has(norm(p)) || [...files.keys()].some((k) => k.startsWith(norm(p) + '/')),
    readdirSync: (p) => {
      if (unreadableDirs.has(norm(p))) throw new Error('EACCES');
      const prefix = norm(p) + '/';
      const direct = new Set();
      for (const k of files.keys()) {
        if (!k.startsWith(prefix)) continue;
        const rest = k.slice(prefix.length);
        if (rest) direct.add(rest.split('/')[0]);
      }
      return [...direct].map((name) => ({ name, isDirectory: () => !files.has(prefix + name) }));
    },
    lstatSync: (p) => {
      if (files.has(norm(p))) {
        const isDir = false;
        return { isFile: () => !isDir, isSymbolicLink: () => false, mode: 0o644 };
      }
      if ([...files.keys()].some((k) => k.startsWith(norm(p) + '/'))) {
        return { isFile: () => false, isSymbolicLink: () => false, mode: 0o755 };
      }
      throw new Error('symlink-or-missing (memfs treats unknown as symlink case)');
    },
    readFileSync: (p) => {
      const v = files.get(norm(p));
      if (v === undefined) throw new Error('ENOENT');
      return v;
    },
    writeFileSync: (p, d) => files.set(norm(p), d),
    copySync: (s, d) => {
      for (const [k, v] of [...files]) if (k === s || k.startsWith(s + '/')) files.set(d + k.slice(s.length), v);
    },
    mkdirSync: () => {},
    renameSync: (from, to) => {
      for (const [k, v] of [...files])
        if (k === from || k.startsWith(from + '/')) files.set(to + k.slice(from.length), v);
      for (const [k] of [...files]) if (k === from || k.startsWith(from + '/')) files.delete(k);
    },
    rmSync: (p) => {
      for (const [k] of [...files]) if (k === p || k.startsWith(p + '/')) files.delete(k);
    },
  };
  return fs;
}

function profileFs(files) {
  return memFs(files ?? new Map());
}

test('audit: deep plugin scripts detected (no depth cap), unreadable dir is violation, symlink red', () => {
  const deep = memFs(
    new Map([
      ['/p/.auth/user', 't'],
      ['/p/.account-fingerprint', 'f'.repeat(16)],
    ]),
  );
  deep.files.set('/p/plugins/1/2/3/4/5/6/7/evil.js', 'x');
  const a1 = auditQoderProfile('/p', deep);
  assert.equal(a1.ok, false);
  assert.ok(
    a1.violations.some((v) => v.includes('evil.js')),
    'depth-8 script detected',
  );

  const unreadable = memFs(
    new Map([
      ['/p/.auth/user', 't'],
      ['/p/.account-fingerprint', 'f'.repeat(16)],
    ]),
    new Set(['/p/plugins']),
  );
  unreadable.files.set('/p/plugins/data', '');
  const a2 = auditQoderProfile('/p', unreadable);
  assert.equal(a2.ok, false);
  assert.ok(a2.violations.some((v) => v.includes('unreadable')));
});

test('audit: hooks:{} counts as empty (no violation), non-empty hooks red', () => {
  const fs1 = memFs(
    new Map([
      ['/p/.auth/user', 't'],
      ['/p/.account-fingerprint', 'f'.repeat(16)],
      ['/p/settings.json', '{"hooks":{}}'],
    ]),
  );
  assert.equal(auditQoderProfile('/p', fs1).ok, true);
  const fs2 = memFs(
    new Map([
      ['/p/.auth/user', 't'],
      ['/p/.account-fingerprint', 'f'.repeat(16)],
      ['/p/settings.json', '{"hooks":{"SessionStart":[]}}'],
    ]),
  );
  assert.equal(auditQoderProfile('/p', fs2).ok, false);
});

// ── ensure 生命周期（真临时目录）：seed / 复用 / 换绑 / 失败保留 ───────────
function makeAuth(root, token) {
  const dir = join(root, 'auth-' + token);
  mkdirSync(join(dir, '.auth'), { recursive: true });
  writeFileSync(join(dir, '.auth', 'user'), token);
  return dir;
}
const realFs = {
  existsSync,
  readdirSync: (p, o) => (import('node:fs').then ? [] : []),
  lstatSync: (p) => import('node:fs'),
};

test('lifecycle: seed, reuse, account A→B rebind (no stale credentials), failed swap keeps old profile', async () => {
  const fsmod = await import('node:fs');
  const real = {
    existsSync: (p) => fsmod.existsSync(p),
    readdirSync: (p, o) => fsmod.readdirSync(p, o),
    lstatSync: (p) => fsmod.lstatSync(p),
    readFileSync: (p) => fsmod.readFileSync(p, 'utf8'),
    writeFileSync: (p, d) => fsmod.writeFileSync(p, d),
    copySync: (s, d) => cpSync(s, d, { recursive: true }),
    mkdirSync: (p, o) => fsmod.mkdirSync(p, o),
    renameSync: (f, t) => fsmod.renameSync(f, t),
    rmSync: (p, o) => fsmod.rmSync(p, o),
  };
  const root = mkdtempSync(join(tmpdir(), 'qoder-life-'));
  const authA = makeAuth(root, 'token-A');
  const authB = makeAuth(root, 'token-B');

  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: real });
  assert.equal(first.audit.ok, true);
  assert.equal(readFileSync(join(first.profileDir, '.auth', 'user'), 'utf8'), 'token-A');

  const reuse = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA, fs: real });
  assert.equal(reuse.audit.ok, true);
  assert.equal(reuse.audit.swapped, undefined, 'same account reuses profile');

  const rebind = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authB, fs: real });
  assert.equal(rebind.audit.ok, true);
  assert.equal(rebind.audit.swapped, 'rebind-account');
  assert.equal(
    readFileSync(join(rebind.profileDir, '.auth', 'user'), 'utf8'),
    'token-B',
    'A→B must not keep A credentials',
  );

  // 失败的 swap（auth source 不可读）保留旧 profile
  const before = readFileSync(join(rebind.profileDir, '.auth', 'user'), 'utf8');
  const failed = ensureQoderRuntimeProfile({
    dataRoot: root,
    catId: 'c1',
    authSourceDir: join(root, 'missing'),
    fs: real,
  });
  assert.equal(failed.audit.ok, false);
  assert.equal(
    readFileSync(join(rebind.profileDir, '.auth', 'user'), 'utf8'),
    before,
    'old profile preserved on failed swap',
  );

  rmSync(root, { recursive: true, force: true });
});

// ── Service invoke（fake spawn，L1 夹具）──────────────────────────────────
function fakeChild(lines, opts = {}) {
  const child = new EventEmitter();
  child.stdout = Readable.from(lines.map((l) => l + '\n'));
  child.stderr = Readable.from((opts.stderr ?? []).map((l) => l + '\n'));
  child.stdin = { write() {}, end() {} };
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit('close', opts.exitCode ?? 0);
  };
  queueMicrotask(() => child.emit('close', opts.exitCode ?? 0));
  return child;
}

function greenProfileFs() {
  return memFs(
    new Map([
      ['/p/.auth/user', 't'],
      ['/p/.account-fingerprint', 'f'.repeat(16)],
    ]),
  );
}

async function runInvoke(svc, prompt, options) {
  const out = [];
  for await (const m of svc.invoke(prompt, options)) out.push(m);
  return out;
}

test('invoke: workingDirectory missing → fail closed, no spawn', async () => {
  let spawned = 0;
  const svc = new QoderAgentService({
    catId: CAT,
    profileDir: '/p',
    model: 'Auto',
    binary: '/usr/bin/true',
    profileFs: greenProfileFs(),
    spawnFn: () => {
      spawned++;
      return fakeChild([]);
    },
  });
  const out = await runInvoke(svc, 'hi', {});
  assert.equal(spawned, 0);
  assert.ok(out[0].type === 'error' && out[0].error.includes('workingDirectory'));
});

test('invoke: success fixture → done with real init model + billing; argv has no prompt text', async () => {
  let seenArgs;
  const lines = fixtureLines('success');
  const svc = new QoderAgentService({
    catId: CAT,
    profileDir: '/p',
    model: 'Auto',
    binary: '/usr/bin/true',
    profileFs: greenProfileFs(),
    spawnFn: (_cmd, args) => {
      seenArgs = args;
      return fakeChild(lines);
    },
  });
  const out = await runInvoke(svc, 'reply with exactly: ok', { workingDirectory: '/tmp' });
  assert.ok(!seenArgs.includes('reply with exactly: ok'), 'prompt not in argv');
  const done = out.find((m) => m.type === 'done');
  assert.ok(done, 'done emitted');
  assert.equal(done.metadata.model, 'Auto', 'actual init model in metadata');
  assert.ok(done.metadata.qoderBilling.credits > 0);
});

test('invoke: auth-error fixture → error terminal, never done (P1-D dialect trap)', async () => {
  const svc = new QoderAgentService({
    catId: CAT,
    profileDir: '/p',
    model: 'Auto',
    binary: '/usr/bin/true',
    profileFs: greenProfileFs(),
    spawnFn: () => fakeChild(fixtureLines('auth-error'), { exitCode: 1 }),
  });
  const out = await runInvoke(svc, 'hi', { workingDirectory: '/tmp' });
  assert.ok(!out.some((m) => m.type === 'done'), 'no done for error result');
  assert.ok(out.some((m) => m.type === 'error' && /Not logged in|result error/.test(m.error)));
});

test('invoke: tool-use fixture (full tool surface) → init gate red, stream aborted', async () => {
  const svc = new QoderAgentService({
    catId: CAT,
    profileDir: '/p',
    model: 'Auto',
    binary: '/usr/bin/true',
    profileFs: greenProfileFs(),
    spawnFn: () => fakeChild(fixtureLines('tool-use')),
  });
  const out = await runInvoke(svc, 'hi', { workingDirectory: '/tmp' });
  assert.ok(!out.some((m) => m.type === 'done'));
  assert.ok(out.some((m) => m.type === 'error' && m.error.includes('init gate')));
});

test('invoke: assistant before init → fail closed', async () => {
  const assistantLine = fixtureLines('tool-use').find((l) => l.includes('"type":"assistant"'));
  const svc = new QoderAgentService({
    catId: CAT,
    profileDir: '/p',
    model: 'Auto',
    binary: '/usr/bin/true',
    profileFs: greenProfileFs(),
    spawnFn: () => fakeChild([assistantLine]),
  });
  const out = await runInvoke(svc, 'hi', { workingDirectory: '/tmp' });
  assert.ok(out.some((m) => m.type === 'error' && m.error.includes('before passing init gate')));
});

test('invoke: nonzero exit without successful result → error with stderr diagnostics', async () => {
  const svc = new QoderAgentService({
    catId: CAT,
    profileDir: '/p',
    model: 'Auto',
    binary: '/usr/bin/true',
    profileFs: greenProfileFs(),
    spawnFn: () => fakeChild(fixtureLines('success'), { exitCode: 3, stderr: ['boom'] }),
  });
  const out = await runInvoke(svc, 'hi', { workingDirectory: '/tmp' });
  const err = out.find((m) => m.type === 'error');
  assert.ok(err && err.error.includes('code 3') && err.error.includes('boom'));
});

test('invoke: default profile fs works on real dirs (default-constructor path)', async () => {
  // 无 profileFs 注入：真实 fs + 真临时绿 profile（覆盖 defaultQoderProfileFs 路径）
  const root = mkdtempSync(join(tmpdir(), 'qoder-default-'));
  const prof = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'd1', authSourceDir: makeAuth(root, 'tok') });
  assert.equal(prof.audit.ok, true);
  const svc = new QoderAgentService({
    catId: CAT,
    profileDir: prof.profileDir,
    model: 'Auto',
    binary: '/usr/bin/true',
    spawnFn: () => fakeChild(fixtureLines('success')),
  });
  const out = await runInvoke(svc, 'hi', { workingDirectory: '/tmp' });
  assert.ok(out.some((m) => m.type === 'done'));
  rmSync(root, { recursive: true, force: true });
});

// ══ round-2 P1 回归：全部走真实 invoke() ═══════════════════════════════════

test('round2 P1-2: beforeProviderLaunch rejecting → 0 spawn, no prompt leaves', async () => {
  let spawned = 0;
  const svc = new QoderAgentService({
    catId: CAT,
    profileDir: '/p',
    model: 'Auto',
    binary: '/usr/bin/true',
    profileFs: greenProfileFs(),
    spawnFn: () => {
      spawned++;
      return fakeChild(fixtureLines('success'));
    },
  });
  const out = await runInvoke(svc, 'must-not-send', {
    workingDirectory: '/tmp',
    beforeProviderLaunch: async () => {
      throw new Error('recorder says no');
    },
  });
  assert.equal(spawned, 0, 'recorder rejection must prevent spawn');
  assert.ok(out.some((m) => m.type === 'error' && m.error.includes('recorder')));
});

test('round2 P1-3: pre-aborted signal → 0 spawn, prompt never written', async () => {
  let spawned = 0;
  let written = '';
  const ac = new AbortController();
  ac.abort();
  const svc = new QoderAgentService({
    catId: CAT,
    profileDir: '/p',
    model: 'Auto',
    binary: '/usr/bin/true',
    profileFs: greenProfileFs(),
    spawnFn: () => {
      spawned++;
      return fakeChild([]);
    },
  });
  // 直接验证：不注入 spawn 捕获 prompt（stdin fake 记录）
  const child = new EventEmitter();
  child.stdout = Readable.from([]);
  child.stderr = Readable.from([]);
  child.stdin = {
    write: (s) => {
      written += s;
    },
    end() {},
  };
  child.kill = () => {};
  const svc2 = new QoderAgentService({
    catId: CAT,
    profileDir: '/p',
    model: 'Auto',
    binary: '/usr/bin/true',
    profileFs: greenProfileFs(),
    spawnFn: () => {
      spawned++;
      return child;
    },
  });
  const out = await runInvoke(svc2, 'must-not-send', { workingDirectory: '/tmp', signal: ac.signal });
  assert.equal(spawned, 0, 'pre-aborted signal must prevent spawn entirely');
  assert.equal(written, '');
  assert.ok(out.some((m) => m.type === 'error' && m.error.includes('aborted')));
});

test('round2 P1-4: streaming — messages yield before stream end (no full buffering)', async () => {
  // init + assistant 通过后，流保持打开：首个 next() 必须已能拿到 session_init
  const child = new EventEmitter();
  const ctrl = new (await import('node:stream')).Readable({ read() {} });
  child.stdout = ctrl;
  child.stderr = Readable.from([]);
  child.stdin = { write() {}, end() {} };
  child.kill = () => {
    child.emit('close', 0);
  };
  const svc = new QoderAgentService({
    catId: CAT,
    profileDir: '/p',
    model: 'Auto',
    binary: '/usr/bin/true',
    profileFs: greenProfileFs(),
    spawnFn: () => {
      const init = fixtureLines('hook-green-project').find((l) => l.includes('"subtype":"init"'));
      ctrl.push(init + '\n');
      return child;
    },
  });
  const iter = svc.invoke('hi', { workingDirectory: '/tmp' });
  const first = await iter.next();
  assert.ok(first.done !== true);
  assert.equal(first.value.type, 'session_init', 'init yielded while stream still open');
  // 终结流（result + EOF + close），迭代到 done
  ctrl.push(fixtureLines('success').find((l) => l.includes('"type":"result"')) + '\n');
  ctrl.push(null);
  child.emit('close', 0);
  let done = false;
  for await (const m of iter) if (m.type === 'done') done = true;
  assert.ok(done);
});

test('round2 P1-5: stderr secrets redacted before reaching user-visible error', async () => {
  const secret = 'Authorization: Bearer sk-proj-1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const svc = new QoderAgentService({
    catId: CAT,
    profileDir: '/p',
    model: 'Auto',
    binary: '/usr/bin/true',
    profileFs: greenProfileFs(),
    spawnFn: () => fakeChild(fixtureLines('auth-error'), { exitCode: 1, stderr: [secret] }),
  });
  const out = await runInvoke(svc, 'hi', { workingDirectory: '/tmp' });
  const err = out.find((m) => m.type === 'error');
  assert.ok(err);
  assert.ok(!err.error.includes('sk-proj-1234567890'), 'raw token must not leak');
  assert.ok(err.error.includes('<redacted>') || !err.error.includes('Bearer sk-'), 'redaction applied');
});

test('round2 P1-7: swap rename failure leaves no staging orphan with credentials', async () => {
  const fsmod = await import('node:fs');
  const root = mkdtempSync(join(tmpdir(), 'qoder-fault-'));
  const authA = makeAuth(root, 'token-A');
  const authB = makeAuth(root, 'token-B');
  const first = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authA });
  assert.equal(first.audit.ok, true);
  let renameCalls = 0;
  const fs = {
    existsSync: (p) => fsmod.existsSync(p),
    readdirSync: (p, o) => fsmod.readdirSync(p, o),
    lstatSync: (p) => fsmod.lstatSync(p),
    readFileSync: (p) => fsmod.readFileSync(p, 'utf8'),
    writeFileSync: (p, d) => fsmod.writeFileSync(p, d),
    copySync: (s, d) => cpSync(s, d, { recursive: true }),
    mkdirSync: (p, o) => fsmod.mkdirSync(p, o),
    renameSync: (f, t) => {
      renameCalls++;
      // 只打中 staging→live 那一步；回滚 rename 放行（真实单点故障）
      if (renameCalls === 2) throw new Error('EIO injected');
      fsmod.renameSync(f, t);
    },
    rmSync: (p, o) => fsmod.rmSync(p, o),
  };
  const failed = ensureQoderRuntimeProfile({ dataRoot: root, catId: 'c1', authSourceDir: authB, fs });
  assert.equal(failed.audit.ok, false, 'swap with injected EIO fails');
  // live 仍为 A（回滚），且不残留任何含 B 凭证的 staging 目录
  assert.equal(fsmod.readFileSync(join(first.profileDir, '.auth', 'user'), 'utf8'), 'token-A');
  const leftovers = fsmod.readdirSync(join(root, 'qoder-profiles')).filter((n) => n.includes('staging'));
  assert.equal(leftovers.length, 0, 'no staging orphan with new-account credentials');
  rmSync(root, { recursive: true, force: true });
});
