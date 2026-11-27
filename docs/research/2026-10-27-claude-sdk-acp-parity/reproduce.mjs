import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

// 仅运行真实适配器代码和合成内存会话；不创建 Claude 会话、不启动 native、不调用模型。
const [adapterArg, protocolArg, outputArg] = process.argv.slice(2);
assert(adapterArg && protocolArg && outputArg, 'usage: node reproduce.mjs ADAPTER PROTOCOL OUTPUT');
const adapter = resolve(adapterArg);
const protocol = resolve(protocolArg);
const output = resolve(outputArg);
const home = join(adapter, '..', 'probe-home');
await mkdir(home, { recursive: true });
process.env.CLAUDE_CONFIG_DIR = home;
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const hash = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const meta = await readJson(join(protocol, 'schema/v1/meta.json'));
const schema = await readJson(join(protocol, 'schema/v1/schema.json'));
const definitions = schema.$defs ?? schema.definitions;
const promptProperties = Object.keys(definitions.PromptRequest.properties);
assert(!Object.values(meta.agentMethods).some((method) => /steer|append/.test(method)));
assert(!promptProperties.includes('priority'));

const { ClaudeAcpAgent } = await import(pathToFileURL(join(adapter, 'dist/acp-agent.js')));
const agent = new ClaudeAcpAgent({ sessionUpdate: async () => {} }, { log() {}, error() {} });
const init = await agent.initialize({ protocolVersion: 1, clientCapabilities: {} });
assert.equal(init._meta.steering.supported, true);
let promptCalls = 0;
agent.prompt = async () => { promptCalls++; return { stopReason: 'end_turn' }; };
const text = [{ type: 'text', text: 'RESEARCH-SYNTHETIC-FOLLOWUP' }];
const captures = [];
const running = { settled: false, promptUuid: 'synthetic-primary' };
agent.sessions.fixture = {
  input: { push: (message) => captures.push(message) },
  turnQueue: [running],
  openUserInputs: new Map(),
};
const normal = await agent.steer({ sessionId: 'fixture', prompt: text });
assert.equal(captures.at(-1).priority, 'now');
assert.deepEqual(normal, { outcome: 'injected' });
const ordinaryPriority = captures.at(-1).priority;
const requestedNext = await agent.steer({ sessionId: 'fixture', prompt: text,
  _meta: { steering: { delivery: 'next' } } });
assert.equal(captures.at(-1).priority, 'now');
assert.deepEqual(requestedNext, { outcome: 'injected' });
agent.sessions.fixture.openUserInputs.set('synthetic-permission', {});
await agent.steer({ sessionId: 'fixture', prompt: text });
assert.equal(captures.at(-1).priority, 'later');
const waitingPriority = captures.at(-1).priority;
agent.sessions.fixture.turnQueue = [];
const beforeIdle = captures.length;
const optInIdle = await agent.steer({ sessionId: 'fixture', prompt: text,
  _meta: { steering: { idleBehavior: 'promptRequired' } } });
assert.deepEqual(optInIdle, { outcome: 'promptRequired', reason: 'noRunningTurn' });
assert.equal(captures.length, beforeIdle);
assert.equal(promptCalls, 0);
const legacyIdle = await agent.steer({ sessionId: 'fixture', prompt: text });
assert.deepEqual(legacyIdle, { outcome: 'startedNewTurn' });
assert.equal(promptCalls, 1);

// 真实 stdio/JSON-RPC：只握手和调用未知会话，拒绝创建 native session。
const env = Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP',
  'COMSPEC', 'PATHEXT'].filter((key) => process.env[key]).map((key) => [key, process.env[key]]));
Object.assign(env, { HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: home,
  CLAUDE_AGENT_ACP_PROTOCOL: 'v1' });
const child = spawn(process.execPath, [join(adapter, 'dist/index.js')],
  { cwd: home, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
let buffer = '';
let stderr = '';
let nextId = 0;
const pending = new Map();
child.stderr.on('data', (data) => { stderr = (stderr + data.toString()).slice(-2000); });
child.stdout.on('data', (data) => {
  buffer += data.toString();
  while (buffer.includes('\n')) {
    const end = buffer.indexOf('\n');
    const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    const waiter = pending.get(message.id);
    if (waiter) { pending.delete(message.id); waiter(message); }
  }
});
const request = (method, params) => new Promise((resolveRequest, reject) => {
  const id = ++nextId;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout ${method}: ${stderr}`)); }, 10000);
  pending.set(id, (message) => { clearTimeout(timer); resolveRequest(message); });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
});
let wire;
try {
  const initialized = await request('initialize', { protocolVersion: 1,
    clientCapabilities: {}, clientInfo: { name: 'parity-research', version: '1' } });
  assert.equal(initialized.result.protocolVersion, 1);
  const standard = await request('session/steer', { sessionId: 'synthetic-absent', prompt: text });
  assert.equal(standard.error.code, -32601);
  const extension = await request('_session/steering', { sessionId: 'synthetic-absent', prompt: text });
  assert(extension.error && extension.error.code !== -32601);
  wire = { initialized: initialized.result, standard, extension };
} finally {
  child.stdin.end();
  const exited = new Promise((done) => child.once('exit', done));
  await Promise.race([exited, new Promise((done) => setTimeout(done, 2000))]);
  if (child.exitCode === null) {
    child.kill();
    await exited;
  }
}
const result = {
  observedAt: new Date().toISOString(), kind: 'actual_adapter_with_synthetic_memory_session_and_real_stdio',
  modelCalls: 0, nativeSessionsCreated: 0, adapterVersion: init.agentInfo.version,
  sdkVersion: (await readJson(join(adapter, 'node_modules/@anthropic-ai/claude-agent-sdk/package.json'))).version,
  process: { pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode,
    stopped: child.exitCode !== null || child.signalCode !== null, ports: [], nativeHome: home },
  standardAgentMethods: meta.agentMethods, promptProperties,
  semantics: { normal, ordinaryPriority, requestedNextPriority: 'now', waitingPriority,
    optInIdle, legacyIdle, syntheticPromptCalls: promptCalls,
    wireReceiptHasNativeUuid: Object.hasOwn(normal, 'nativeInputUuid') }, wire,
  hashes: { adapterSource: await hash(join(adapter, 'src/acp-agent.ts')),
    adapterCompiled: await hash(join(adapter, 'dist/acp-agent.js')),
    packageLock: await hash(join(adapter, 'package-lock.json')),
    schema: await hash(join(protocol, 'schema/v1/schema.json')) },
};
await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ passed: true, output, semantics: result.semantics, modelCalls: 0 }));
