// F210: AGY stream-json carrier parser。
// Fixtures 是 2026-09-20 用 agy 1.2.7 真跑出来的 NDJSON（非手写伪造）：
//   tool-call-turn  — 单轮 + run_command 工具调用
//   resume-turn     — 第二个进程 --conversation 续接，step_index 从 4 起，无累加重放
//   denied-mcp-turn — headless 权限 deny，上游仍报 status:"SUCCESS" + 空 response
//
// 最关键的不变量在第三个 fixture：上游的 `status` **不是** 成败真相。
// 权限被拒时 agy 返回 SUCCESS + 空 response，唯一证据是 `denied_actions`。
// 把它折叠成「成功但没话说」正是 operator 截图那个「CLI 完成但无文字输出」的成因。

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { parseAgyStreamJsonLine, summarizeAgyStreamJsonTurn, encodeAgyStreamJsonUserMessage } = await import(
  '../dist/domains/cats/services/agents/providers/agy-stream-json-parser.js'
);

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'agy-stream-json');

function loadFixture(name) {
  return readFileSync(join(FIXTURE_DIR, `${name}.ndjson`), 'utf8')
    .split('\n')
    .filter(Boolean);
}

test('agy-stream-json-parser', async (t) => {
  await t.test('input encoding uses the `event` envelope, not Claude SDK `type`', () => {
    const line = encodeAgyStreamJsonUserMessage('hello');
    const parsed = JSON.parse(line);
    // 实测：{"type":"user",...} 被 agy 拒为 `stream input message is missing the "event" field`
    assert.equal(parsed.event, 'user');
    assert.equal(parsed.message.role, 'user');
    assert.deepEqual(parsed.message.content, [{ type: 'text', text: 'hello' }]);
    assert.ok(!line.includes('\n'), 'NDJSON line must not embed newlines');
  });

  await t.test('tool call is read from native fields, not reverse-engineered proto', () => {
    const turn = summarizeAgyStreamJsonTurn(loadFixture('tool-call-turn'));

    assert.equal(turn.outcome, 'ok');
    assert.equal(turn.finalText, 'ONE\n');
    assert.equal(turn.toolCalls.length, 1);

    const [call] = turn.toolCalls;
    assert.equal(call.toolName, 'run_command');
    assert.equal(call.parameters.CommandLine, 'echo AGYPROBE_ONE');
    assert.match(call.output, /AGYPROBE_ONE/);
    assert.equal(call.state, 'DONE');
  });

  await t.test('init advertises tools and permission mode', () => {
    const [first] = loadFixture('tool-call-turn');
    const event = parseAgyStreamJsonLine(first);
    assert.equal(event.kind, 'init');
    assert.ok(event.tools.includes('run_command'));
    assert.equal(typeof event.permissionMode, 'string');
  });

  await t.test('resume continues step_index across processes and does NOT replay history', () => {
    const turn = summarizeAgyStreamJsonTurn(loadFixture('resume-turn'));

    // 跨进程续接：上一进程停在 step 3，本进程从 4 起 → 天然增量游标
    assert.equal(turn.firstStepIndex, 4);
    // 本轮输出只含本轮内容。老 plainText 载体在这里会吐出 [第1轮, 第2轮] 累加历史。
    assert.equal(turn.finalText, 'echo AGYPROBE_ONE\nTWO\n');
    assert.equal(turn.outcome, 'ok');
  });

  await t.test('permission denial must NOT be folded into success', () => {
    const turn = summarizeAgyStreamJsonTurn(loadFixture('denied-mcp-turn'));

    // 上游自报 SUCCESS —— 这是必须被推翻的那一层
    assert.equal(turn.upstreamStatus, 'SUCCESS');
    assert.equal(turn.finalText, '');

    // 我们的判定必须是「被拒」这个独立第三态，不是 ok，也不是泛化的 error
    assert.equal(turn.outcome, 'denied');
    assert.deepEqual(
      turn.deniedActions.map((action) => action.action),
      ['mcp'],
    );
    assert.match(turn.diagnosis, /denied/i);
  });

  await t.test('malformed lines fail open instead of throwing', () => {
    assert.equal(parseAgyStreamJsonLine('not json at all'), null);
    assert.equal(parseAgyStreamJsonLine(''), null);
    assert.equal(parseAgyStreamJsonLine('{"event":"brand_new_upstream_event"}').kind, 'unknown');

    // 半行 / 噪音混进来时，已识别的事件仍要被保住
    const turn = summarizeAgyStreamJsonTurn([...loadFixture('tool-call-turn'), '{"event":', 'garbage']);
    assert.equal(turn.finalText, 'ONE\n');
    assert.equal(turn.outcome, 'ok');
  });

  // ── 以下四条来自 local review CHANGES_REQUESTED（HEAD 839dbc1b0f）。
  // 全部是同一个病：协议漂移在到达 decideOutcome 之前就被悄悄抹平成确定结论。
  // 这正是本文件顶部自己声明的那条边界，第一版实现没守住。

  await t.test('unrecognized step state is preserved, never coerced to ACTIVE', () => {
    // 上游若新增 CANCELLED（或任何我们没见过的 state），旧实现一律塞成 ACTIVE，
    // 于是一个被取消的工具调用配上 status:"SUCCESS" 就变成了干净的成功回合。
    const turn = summarizeAgyStreamJsonTurn([
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'c',
          step_index: 0,
          state: 'CANCELLED',
          step_type: 'tool',
          tool_name: 'run_command',
          tool_info: { name: 'run_command', parameters: { CommandLine: 'echo x' } },
        },
      }),
      JSON.stringify({
        event: 'result',
        result: { conversation_id: 'c', status: 'SUCCESS', response: 'done', num_turns: 1 },
      }),
    ]);

    const [call] = turn.toolCalls;
    assert.equal(call.state, 'UNKNOWN');
    assert.equal(call.rawState, 'CANCELLED', '原始 state 必须留着供取证');

    assert.equal(turn.outcome, 'protocol_error', '认不出的协议字段不得产出确定成功');
    assert.deepEqual(
      turn.anomalies.map((anomaly) => anomaly.kind),
      ['unknown_step_state'],
    );
    assert.match(turn.diagnosis, /CANCELLED/);
  });

  await t.test('absent result.response is drift, not an empty answer', () => {
    // `response` 字段缺失 ≠ `response: ""`。旧实现用 `?? ''` 把两者抹平，
    // 于是"上游没给我们文本"被报成"模型确实没说话"。
    const turn = summarizeAgyStreamJsonTurn([
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'c',
          step_index: 0,
          state: 'ACTIVE',
          step_type: 'agent_response',
          text_delta: 'partial',
        },
      }),
      JSON.stringify({ event: 'result', result: { conversation_id: 'c', status: 'SUCCESS', num_turns: 1 } }),
    ]);

    assert.equal(turn.outcome, 'protocol_error');
    assert.deepEqual(
      turn.anomalies.map((anomaly) => anomaly.kind),
      ['missing_result_response'],
    );
    // 没有权威文本时退回本轮已收到的 delta，而不是假装是空回答
    assert.equal(turn.finalText, 'partial');
  });

  await t.test('a genuinely empty response stays `empty`, not protocol_error', () => {
    // 反向守护：上游明确给了 response:"" 时不能误报成漂移。
    const turn = summarizeAgyStreamJsonTurn([
      JSON.stringify({
        event: 'result',
        result: { conversation_id: 'c', status: 'SUCCESS', response: '', num_turns: 1 },
      }),
    ]);
    assert.equal(turn.anomalies.length, 0);
    assert.equal(turn.outcome, 'empty');
  });

  await t.test('same-step tool updates merge instead of overwriting earlier evidence', () => {
    // ACTIVE 带 parameters、DONE 只带 output —— 旧实现整条覆盖，参数凭空消失。
    const turn = summarizeAgyStreamJsonTurn([
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'c',
          step_index: 2,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name: 'run_command',
          tool_info: { name: 'run_command', parameters: { CommandLine: 'echo x' } },
        },
      }),
      JSON.stringify({
        event: 'step_update',
        step_update: {
          conversation_id: 'c',
          step_index: 2,
          state: 'DONE',
          step_type: 'tool',
          tool_name: 'run_command',
          tool_info: { name: 'run_command', output: 'x' },
        },
      }),
    ]);

    const [call] = turn.toolCalls;
    assert.deepEqual(call.parameters, { CommandLine: 'echo x' }, '后到的稀疏事件必须补充而不是抹掉先前证据');
    assert.equal(call.output, 'x');
    assert.equal(call.state, 'DONE', 'state 仍以最新事件为准');
  });

  await t.test('truncated stream stays non-definite (deterministic synthetic cutoff)', () => {
    // 真实截断 fixture 造不稳定；用确定性合成流锁住契约：没有 result 就不许下定论。
    const full = loadFixture('tool-call-turn');
    const truncated = full.slice(0, full.length - 1); // 砍掉终结 result 事件
    const turn = summarizeAgyStreamJsonTurn(truncated);

    assert.equal(turn.upstreamStatus, null);
    assert.equal(turn.outcome, 'incomplete');
    assert.equal(turn.finalText, 'ONE\n', '无权威文本时退回本轮 delta 拼接');
  });

  await t.test('usage accounting is surfaced for the turn', () => {
    const turn = summarizeAgyStreamJsonTurn(loadFixture('tool-call-turn'));
    assert.equal(typeof turn.usage.totalTokens, 'number');
    assert.ok(turn.usage.totalTokens > 0);
    assert.equal(typeof turn.usage.cacheReadTokens, 'number');
  });
});
