/**
 * F317 Phase 1: qoder-ndjson-parser 夹具驱动测试
 * 夹具 = L1 真实采集一代（packages/api/test/fixtures/qoder/current/，verifier 校验过的 generation）
 * + gate-probes（cancel / mcp-mount）+ 方言陷阱负向用例（auth-error 的 subtype 陷阱等）
 */

import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, 'fixtures', 'qoder');

// dist 产物（先 build:packages 或指向 src 编译输出）
const {
  transformQoderEvent,
  isQoderResultErrorEvent,
  extractQoderUsage,
  checkQoderProtocolVersion,
  mapQoderMcpStatus,
} = await import(
  process.env.QODER_PARSER_SRC
    ? '../src/domains/cats/services/agents/providers/qoder-ndjson-parser.ts'
    : '../dist/domains/cats/services/agents/providers/qoder-ndjson-parser.js'
);

const CAT = 'cat_test_qoder';
const loadJsonl = (p) =>
  readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

// 活跃 generation 的夹具（current -> .gen-<hash>/）
const currentDir = join(FIXTURES, 'current');
const readFixture = (name) => loadJsonl(join(currentDir, `${name}.jsonl`));

test('fixture generation is present and parseable', () => {
  const files = readdirSync(currentDir).filter((f) => f.endsWith('.jsonl'));
  assert.ok(files.length >= 9, `expected >=9 fixtures, got ${files.length}`);
});

test('system/init -> session_init + mcp status with dialect mapping', () => {
  // mcp-mount 在 gate-probes 下；这里用 hook-green-project（含 init）
  const initRow = readFixture('hook-green-project').find((r) => r.subtype === 'init');
  assert.ok(initRow, 'init event present');
  const out = transformQoderEvent(initRow, CAT);
  const sessionInit = Array.isArray(out) ? out[0] : out;
  assert.equal(sessionInit.type, 'session_init');
  assert.equal(typeof sessionInit.sessionId, 'string');
});

test('mcp status vocabulary: disconnected maps to failed (P1-C)', () => {
  assert.equal(mapQoderMcpStatus('disconnected'), 'failed');
  assert.equal(mapQoderMcpStatus('connected'), 'connected');
  assert.equal(mapQoderMcpStatus('weird-status'), undefined);
  const init = {
    type: 'system',
    subtype: 'init',
    session_id: 's1',
    mcp_servers: [{ name: 'x', status: 'disconnected' }],
  };
  const out = transformQoderEvent(init, CAT);
  const payload = JSON.parse(out[1].content);
  assert.equal(payload.servers[0].status, 'failed');
});

test('assistant text/thinking/tool_use blocks pass through (isomorphic)', () => {
  const rows = readFixture('tool-use');
  const events = rows.flatMap((r) => {
    const out = transformQoderEvent(r, CAT);
    return out == null ? [] : Array.isArray(out) ? out : [out];
  });
  const toolUse = events.find((m) => m.type === 'tool_use');
  assert.ok(toolUse, 'tool_use emitted');
  assert.equal(toolUse.toolName, 'Read');
  assert.equal(typeof toolUse.toolUseId, 'string');
});

test('auth-error dialect trap: is_error=true overrides subtype==="success" (P1-D)', () => {
  const rows = readFixture('auth-error');
  const resultRow = rows.find((r) => r.type === 'result');
  assert.equal(resultRow.subtype, 'success', 'fixture proves the trap shape');
  assert.equal(resultRow.is_error, true);
  assert.equal(isQoderResultErrorEvent(resultRow), true);
  const out = transformQoderEvent(resultRow, CAT);
  assert.equal(out.type, 'error');
});

test('permission denial: tool_result is_error is NOT an invocation error (terminal structured fields unreliable)', () => {
  const rows = readFixture('permission-denial');
  const resultRow = rows.find((r) => r.type === 'result');
  // 终态 result 是成功 invocation（is_error:false）——判错只认 is_error
  assert.equal(isQoderResultErrorEvent(resultRow), false);
  const out = transformQoderEvent(resultRow, CAT);
  assert.equal(out, null);
});

test('usage dialect: token fields are 0, credits are the real account (P1-B)', () => {
  const rows = readFixture('success');
  const resultRow = rows.find((r) => r.type === 'result');
  const { usage, billing } = extractQoderUsage(resultRow);
  // TokenUsage 不得含伪 token 数（result.usage 全 0）
  assert.equal(usage.inputTokens, undefined);
  assert.ok(billing.credits > 0, `credits captured: ${billing.credits}`);
  assert.ok(typeof resultRow.usage.context_usage_ratio === 'number');
});

test('contextWindow:0 guard — must not pollute contextWindowSize', () => {
  const rows = readFixture('silent-model-fallback');
  const resultRow = rows.find((r) => r.type === 'result');
  assert.equal(resultRow.modelUsage.auto.contextWindow, 0, 'fixture proves the zero shape');
  const { usage } = extractQoderUsage(resultRow);
  assert.equal(usage.contextWindowSize, undefined);
});

test('protocol version gate: known passes, unknown fails closed (P1-H)', () => {
  assert.equal(checkQoderProtocolVersion({ protocol_version: '1.4.0' }).ok, true);
  const bad = checkQoderProtocolVersion({ protocol_version: '2.0.0' });
  assert.equal(bad.ok, false);
  const drift = checkQoderProtocolVersion({ protocol_version: '1.4.0', qodercli_version: '1.2.0' });
  assert.equal(drift.ok, true);
  assert.match(drift.cliDrift, /1\.2\.0/);
});

test('qoder-only events pass through as system_info (P1-E), agent_loop never emitted (I-6)', () => {
  const rows = readFixture('success');
  const events = rows.flatMap((r) => {
    const out = transformQoderEvent(r, CAT);
    return out == null ? [] : Array.isArray(out) ? out : [out];
  });
  assert.equal(
    events.some((m) => m.type === 'agent_loop'),
    false,
    'I-6: agent_loop must not be emitted',
  );
  const hookInfo = events.find((m) => m.type === 'system_info' && JSON.parse(m.content).type === 'qoder_hook');
  assert.ok(hookInfo, 'hook events surfaced as system_info');
});

test('cancel signature from gate probe: graceful cancel still emits terminal result', () => {
  const rows = loadJsonl(join(FIXTURES, 'gate-probes', 'cancel.jsonl'));
  // 修正后的事实：SIGINT = 优雅取消，终态 result 正常收尾（exit 130 由 wrapper 体现）
  assert.equal(
    rows.some((r) => r.type === 'result'),
    true,
    'terminal result present',
  );
  const resultRow = rows.find((r) => r.type === 'result');
  assert.equal(isQoderResultErrorEvent(resultRow), false);
  const events = rows.flatMap((r) => {
    const out = transformQoderEvent(r, CAT);
    return out == null ? [] : Array.isArray(out) ? out : [out];
  });
  assert.equal(
    events.some((m) => m.type === 'error'),
    false,
  );
});
