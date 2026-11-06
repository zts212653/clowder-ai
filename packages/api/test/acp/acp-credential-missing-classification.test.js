// Issue #1798: DSH ACP 默认路由凭据引用缺失时诊断与修复引导不足
//
// 报文来源：2026-11-03 的三组真实 stdio ACP 采证（report.json 的 a-original-acp case）。
// 该报告记录的是 **AcpProtocolError 构造之后的 Error.message**，已经带 `ACP error -32603: `
// 前缀；而构造器会自行补这个前缀。因此这里传的是其后的 wire 正文，避免二次前缀——
// 传报告里的完整 message 会让断言落在 "ACP error -32603: ACP error -32603: ..." 上。
//
// 报文中的 provider / 引用名一律换成中性假名（custom-*），格式与真实报文一致。
// 分类只能锚定 message 文本：真实信封只有 { name, code, message }，没有结构化 data.error。
//
// 本文件同时钉死两件事：
//   1) 明确的缺凭据错误要落到专用分类并给出可操作说明；
//   2) 一般错误与"路由名恰好含 mcp/capacity"的缺凭据错误都不能被既有启发式抢走。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/** 自定义 llm-pi-ai 路由缺凭据引用的 wire 正文（脱敏，格式与真实报文一致）。 */
const WIRE_MISSING_CREDENTIAL_REF =
  'Internal error: turn failed: llm-pi-ai: no credential for provider route ' +
  '"custom-acp-route"; its profile resolves CUSTOM_ACP_API_KEY, which is not set — ' +
  'store CUSTOM_ACP_API_KEY through the credentials service (the web Models page writes it) ' +
  'or export it, and remove apiKeyEnv only if this provider should authenticate from pi-ai own ' +
  'environment discovery';

/** 官方 llm-deepseek 路由的缺 key 形态（#1668 历史现场，措辞不同）。 */
const WIRE_MISSING_API_KEY =
  'Internal error: turn failed: llm-deepseek: no API key for provider route ' +
  '"deepseek-official"; store DEEPSEEK_API_KEY through the credentials service';

/**
 * 用真实 AcpAgentService 走一遍 invoke，读取最终 error envelope。
 * 与 pi-acp-bridge.test.js 的既有 fixture 手法一致：在 host classifier 边界注入协议错误。
 */
async function invokeWithProtocolError({ code, message, data, providerName = 'ACP agent' }) {
  const root = mkdtempSync(join(tmpdir(), 'acp-cred-classify-'));
  const calls = { acquire: 0, newSession: 0, prompt: 0, release: 0 };
  try {
    const { AcpAgentService } = await import(
      '../../dist/domains/cats/services/agents/providers/acp/AcpAgentService.js'
    );
    const { AcpProtocolError } = await import('../../dist/domains/cats/services/agents/providers/acp/AcpClient.js');
    const client = {
      promptCapabilities: {},
      onCapacity() {},
      offCapacity() {},
      clearRecentCapacitySignal() {},
      cancelSession() {},
      async newSession() {
        calls.newSession++;
        return { sessionId: 'session-cred' };
      },
      async *promptStream() {
        calls.prompt++;
        throw new AcpProtocolError(code, message, data);
      },
    };
    const service = new AcpAgentService({
      catId: 'acp-cred-fixture',
      pool: {
        async acquire() {
          calls.acquire++;
          return {
            client,
            release() {
              calls.release++;
            },
          };
        },
      },
      poolKey: {},
      projectRoot: root,
      mcpSupport: false,
      providerName,
    });
    const messages = [];
    for await (const message of service.invoke('task', { workingDirectory: root })) messages.push(message);
    assert.deepEqual(calls, { acquire: 1, newSession: 1, prompt: 1, release: 1 }, 'ordinary failures must not retry');
    assert.equal(messages.filter((item) => item.type === 'error').length, 1);
    assert.equal(messages.filter((item) => item.type === 'done').length, 1);
    assert.equal(messages.at(-1).type, 'done');
    const error = messages.find((m) => m.type === 'error');
    assert.ok(error, 'expected an error message from invoke()');
    return error;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('display-only ACP diagnostics cannot replace genuine credential, capacity or MCP failure causes', async () => {
  for (const [message, expected] of [
    [WIRE_MISSING_API_KEY, 'credential_missing'],
    ['Provider capacity exhausted', 'model_capacity'],
    ['MCP server request failed', 'mcp_pollution'],
  ]) {
    const error = await invokeWithProtocolError({
      code: -32603,
      message,
      data: { diagnostics: 'recent Pi CLI diagnostics: benign mcp capacity status; api_key=secret-diagnostic-token' },
    });
    assert.equal(error.errorCode, expected);
    assert.doesNotMatch(error.error, /recent Pi CLI diagnostics|secret-diagnostic-token/);
    assert.match(error.metadata.cliDiagnostics.safeExcerpt, /recent Pi CLI diagnostics/);
    assert.doesNotMatch(error.metadata.cliDiagnostics.safeExcerpt, /secret-diagnostic-token/);
    assert.equal(error.metadata.cliDiagnostics.reasonCode, undefined);
  }
});

test('DSH 缺凭据引用被识别为 credential_missing 并给出可操作说明', async () => {
  const error = await invokeWithProtocolError({ code: -32603, message: WIRE_MISSING_CREDENTIAL_REF });

  assert.equal(error.errorCode, 'credential_missing');
  // 必须点名缺失的引用名，而不是含糊地说"凭据问题"
  assert.match(error.error, /CUSTOM_ACP_API_KEY/);
  // 必须点出当前路由
  assert.match(error.error, /custom-acp-route/);
  // 必须澄清这是引用名称，不是 Key 正文
  assert.match(error.error, /引用名称|reference name/);
  // 原始证据保留可 grep 性
  assert.match(error.error, /^credential_missing:/);
});

test('官方 llm-deepseek 路由的缺 key 形态同样被识别', async () => {
  const error = await invokeWithProtocolError({ code: -32603, message: WIRE_MISSING_API_KEY });

  assert.equal(error.errorCode, 'credential_missing');
  assert.match(error.error, /deepseek-official/);
});

test('说明不得暗示"换成另一个 key 名字即可"（反例约束）', async () => {
  const error = await invokeWithProtocolError({ code: -32603, message: WIRE_MISSING_CREDENTIAL_REF });

  // operator 本机就是靠改引用名解决的，但那是知道自己在做什么时的操作。
  // 产品文案不能把这引导成通用做法，也不能承诺自动借用其他账户密钥。
  assert.doesNotMatch(error.error, /改成|换成|改为|自动.*(借用|替换|别名)/);
  assert.doesNotMatch(error.error, /alias/i);
});

test('路由名恰好含 mcp 时，缺凭据仍归 credential_missing，不被 mcp_pollution 抢走', async () => {
  const message =
    'Internal error: turn failed: llm-pi-ai: no credential for provider route ' +
    '"mcp-gateway"; its profile resolves MCP_GATEWAY_KEY, which is not set';
  const error = await invokeWithProtocolError({ code: -32603, message });

  assert.equal(error.errorCode, 'credential_missing');
});

test('路由名恰好含 capacity 时，缺凭据仍归 credential_missing，不被 model_capacity 抢走', async () => {
  const message =
    'Internal error: turn failed: llm-pi-ai: no credential for provider route ' +
    '"capacity-prod"; its profile resolves CAPACITY_PROD_KEY, which is not set';
  const error = await invokeWithProtocolError({ code: -32603, message });

  assert.equal(error.errorCode, 'credential_missing');
});

test('一般 ACP 错误保持原分类，不被新分支误收', async () => {
  // 普通 -32603，不含任何缺凭据措辞
  const generic = await invokeWithProtocolError({
    code: -32603,
    message: 'Internal error: turn failed: something else went wrong',
  });
  assert.equal(generic.errorCode, 'prompt_failure');

  // -32000 仍然判容量
  const capacity = await invokeWithProtocolError({
    code: -32000,
    message: 'ACP error -32000: Internal error: server overloaded',
  });
  assert.equal(capacity.errorCode, 'model_capacity');

  // 明确的 MCP 服务端错误仍然判 mcp_pollution
  const mcp = await invokeWithProtocolError({
    code: -32603,
    message: 'Internal error: MCP server returned an error',
  });
  assert.equal(mcp.errorCode, 'mcp_pollution');
});

test('401/403/429 不被归入 credential_missing', async () => {
  for (const message of [
    'Internal error: upstream returned 401 Unauthorized',
    'Internal error: upstream returned 403 Forbidden',
    'Internal error: upstream returned 429 Too Many Requests',
  ]) {
    const error = await invokeWithProtocolError({ code: -32603, message });
    assert.notEqual(error.errorCode, 'credential_missing', `should not classify: ${message}`);
  }
});

test('脱敏：超长/含换行的伪造诊断片段不被原样带出', async () => {
  const hostile =
    'Internal error: turn failed: llm-pi-ai: no credential for provider route ' +
    `"${'A'.repeat(5000)}\\nINJECTED"; its profile resolves ${'B'.repeat(5000)}, which is not set`;
  const error = await invokeWithProtocolError({ code: -32603, message: hostile });

  assert.equal(error.errorCode, 'credential_missing');
  // 用户可见说明不应把注入内容整段搬出来
  assert.ok(error.error.length < 4000, `error text too long: ${error.error.length}`);
});

// ── R1 复审反例（非作者审查，PR #1808 issuecomment-6599693656）────────────────
// 以下三项在 R1 HEAD 上全部失败，用于钉死复审指出的同类缺陷。

test('P2-1: 官方 llm-deepseek 句式必须同时捕获 route 与凭据引用名', async () => {
  const error = await invokeWithProtocolError({ code: -32603, message: WIRE_MISSING_API_KEY });

  assert.equal(error.errorCode, 'credential_missing');
  // 必须点名路由
  assert.match(error.error, /deepseek-official/);
  // 必须点名引用——R1 只抓 route，UI 上引用名为空
  assert.match(error.error, /DEEPSEEK_API_KEY/);
});

test('P2-2: 非 DSH 的 MCP 错误不得被抢成 credential_missing', async () => {
  // 没有 llm-pi-ai / llm-deepseek 前缀，不是 DSH 的缺凭据签名
  const error = await invokeWithProtocolError({
    code: -32603,
    message: 'MCP server error: no API key for provider route "search-provider"',
  });

  assert.equal(error.errorCode, 'mcp_pollution');
  // 不得指导用户去改 DSH 配置
  assert.doesNotMatch(error.error, /DSH_HOME|apiKeyEnv/);
});

test('P2-2b: 真正的 DSH 缺凭据且路由名含 mcp/capacity 时仍归 credential_missing', async () => {
  // 与 P2-2 配对：收窄匹配后，必须保留"确实是 DSH"的优先级回归
  for (const route of ['mcp-gateway', 'capacity-prod']) {
    const message =
      'Internal error: turn failed: llm-pi-ai: no credential for provider route ' +
      `"${route}"; its profile resolves SOME_KEY, which is not set`;
    const error = await invokeWithProtocolError({ code: -32603, message });
    assert.equal(error.errorCode, 'credential_missing', `route=${route}`);
  }
});

test('P2-3: 路由中的合成密钥不得原样回显到用户可见说明', async () => {
  const fakeToken = `sk-proj-${'a1b2c3d4e5'.repeat(4)}`;
  const message =
    'Internal error: turn failed: llm-pi-ai: no credential for provider route ' +
    `"${fakeToken}"; its profile resolves SOME_KEY, which is not set`;
  const error = await invokeWithProtocolError({ code: -32603, message });

  assert.equal(error.errorCode, 'credential_missing');
  // 复用仓库既有 sanitizer：合成 token 必须被脱敏，不能只做长度限制
  assert.doesNotMatch(error.error, /sk-proj-/);
  assert.ok(!error.error.includes(fakeToken), 'fake token leaked into user-facing text');
});

test('P2-3b: 先脱敏再截断，长 token 不得因截断而绕过识别', async () => {
  // 把 token 放得足够靠后，若先截断则前缀会被切掉、sanitizer 认不出来
  const filler = 'x'.repeat(200);
  const fakeToken = `sk-ant-api03-${'z9y8x7w6v5'.repeat(6)}`;
  const message =
    'Internal error: turn failed: llm-pi-ai: no credential for provider route ' +
    `"${filler}${fakeToken}"; its profile resolves SOME_KEY, which is not set`;
  const error = await invokeWithProtocolError({ code: -32603, message });

  assert.equal(error.errorCode, 'credential_missing');
  assert.doesNotMatch(error.error, /sk-ant-api03-/);
});

test('新旧 ACP 错误码在真实消费者中均保持普通 error/failed，不成为路由恢复信号', async () => {
  const { projectInvocationTerminalEvidence } = await import(
    '../../dist/domains/cats/services/session/InvocationTrajectoryProjector.js'
  );
  const { resolveResponseTerminal } = await import(
    '../../dist/domains/cats/services/agents/routing/response-terminal.js'
  );
  const { classifyRoutingDispatchFailure } = await import(
    '../../dist/domains/routing-context/RoutingDispatchSignalContract.js'
  );
  const { projectSessionEvent } = await import(
    '../../dist/domains/cats/services/agents/session-contract/event-projection.js'
  );

  for (const code of ['prompt_failure', 'mcp_pollution', 'model_capacity', 'credential_missing']) {
    const event = { type: 'error', errorCode: code };
    assert.deepEqual(projectInvocationTerminalEvidence(event), { status: 'error', reason: code });
    assert.deepEqual(resolveResponseTerminal({ aborted: false, failed: true, errorCode: code }), {
      status: 'failed',
      reason: code,
    });
    assert.equal(classifyRoutingDispatchFailure({ providerErrorCode: code }), undefined);
    const [projected] = projectSessionEvent(
      { type: 'error', code, message: 'isolated ACP failure' },
      { catId: 'acp-cred-fixture', metadata: { provider: 'acp' } },
    );
    assert.equal(projected.type, 'error');
    assert.equal(projected.errorCode, code);
  }
});
