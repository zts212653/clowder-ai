#!/usr/bin/env node
/**
 * F237 Checkpoint B — Template extraction regression verifier.
 * Compares template-loaded output against the original hardcoded strings
 * to ensure byte-level equivalence after extraction.
 *
 * Usage: node scripts/verify-template-extraction.mjs
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const TEMPLATES = join(ROOT, 'assets', 'prompt-templates');

let failures = 0;

function assert(label, actual, expected) {
  // Normalize: trim both to avoid trailing newline differences
  const a = actual.trim();
  const e = expected.trim();
  if (a === e) {
    console.log(`  ✅ ${label}`);
    return;
  }
  failures++;
  console.error(`  ❌ ${label}`);
  // Find first difference
  for (let i = 0; i < Math.max(a.length, e.length); i++) {
    if (a[i] !== e[i]) {
      console.error(`     First diff at char ${i}:`);
      console.error(`     Expected: ${JSON.stringify(e.slice(Math.max(0, i - 20), i + 30))}`);
      console.error(`     Actual:   ${JSON.stringify(a.slice(Math.max(0, i - 20), i + 30))}`);
      break;
    }
  }
}

// ── Template rendering (same logic as prompt-template-loader.ts) ──

function renderTemplate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return key in vars ? vars[key] : match;
  });
}

function stripComments(content) {
  return content
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('<!--'))
    .join('\n')
    .trim();
}

// ── Original hardcoded values ────────────────────────────────

const ORIGINAL_WORKFLOW_TRIGGERS = {
  ragdoll: [
    '## 工作流（主动 @ 触发点）',
    '- 完成开发/修复 → @缅因猫 请 review',
    '- 修完 review 意见 → @缅因猫 确认修复',
    '- MG provenance override：外部finding修完后等PR truth，不@旧reviewer。',
    '- 遇到视觉/体验问题 → @暹罗猫 征询',
    '- Review 别人代码：每个发现给明确立场（放行/退回 + 理由）',
  ].join('\n'),
  'maine-coon': [
    '## 工作流（主动 @ 触发点）',
    '- 完成 review → @布偶猫 通知结果',
    '- 修完 bug/feature → @布偶猫 请 review',
    '- MG provenance override：外部finding修完后等PR truth，不@旧reviewer。',
    '- serial/handoff 场景且需要对方行动 → @ 对应猫（parallel 模式各自独立，不互 @）',
    '- 发现需要架构决策 → @布偶猫 征询',
    '- Review 代码：每个发现给明确立场（放行/退回 + 理由）',
    '- 收到 review 意见：独立判断，认为自己对就 push back（Rule 0），不全盘接受',
    '',
    '### 执行纪律',
    '- 加载 Skill 后直接执行第一步（产出 > 复述）',
    '- 接球后静默执行：收到"放行"后沉默做到下一状态迁移点（BLOCKED / REVIEW READY / DONE）',
    '- 声明 = 执行：说"我进 merge gate"必须同 turn 加载 skill 并执行',
    '- 只发状态迁移消息，中间产物留在代码里',
    '- 完成任务后必须 @ 下一棒',
    '- 若识别到角色不匹配或方向有问题，先通知对方再执行（Rule 0）',
    '',
    '### 出口一问（发消息前必问）',
    '我这条消息结尾有没有 @ 下一棒？没有 → 是真的不需要，还是我忘了？',
    '',
    '### 缅因猫家族治理（fallback 层数检测 F177 Phase D）',
    '同文件新增 ≥3 层 fallback (`try/catch`/`??`/`||`/`else-if`) → 坐标系自检：① 修对还是补错？② 变换消除？③ 每层为何不能去？',
    '',
    '### 长任务纪律',
    '- exec_command session_id 存活 → 续 write_stdin。',
    '- bash&/nohup/disown/setsid = 伪后台；真后台用 detached spawn + unref。',
    '- Fire-and-forget → pid/log/exit 探针轮询。',
  ].join('\n'),
  siamese: [
    '## 工作流（主动 @ 触发点）',
    '- 完成设计/视觉资产 → 分别 @布偶猫 和 @缅因猫 请确认（每只猫各占一行）',
    '- 遇到技术实现问题 → @布偶猫 征询',
    '',
    '### 执行纪律',
    '- 加载 Skill 后直接执行第一步（产出 > 复述）',
    '- 涉及 UI/前端验证时：通过截图产出证据',
    '- 接球后静默执行到下一状态点（DONE / HANDOFF）',
    '- 若识别到角色不匹配或方向有问题，先通知对方再执行（Rule 0）',
    '',
    '### 出口一问（发消息前必问）',
    '我这条消息结尾有没有 @ 下一棒？没有 → 是真的不需要，还是我忘了？',
  ].join('\n'),
};

// Rich block short (same as rich-block-rules.ts RICH_BLOCK_SHORT)
const RICH_BLOCK_SHORT = `富消息块：结构化信息用富块，普通对话不用。先写 1-2 句摘要再发。
⚠️ 字段名是 "kind"（不是 "type"！），必须有 "v": 1 和唯一 id。
支持: card / diff / checklist / media_gallery / audio / interactive / html_widget。
interactive: 用户可交互选择（select/multi-select/card-grid/confirm），详见 rich-blocks rules。`;

const ORIGINAL_MCP_TOOLS = `MCP 工具（异步汇报；token 有效期有限）：

**记忆工具：**
- cat_cafe_search_evidence: 首选入口；depth=raw 可看消息级细节
- cat_cafe_library_*: collection管理(list/create/rebuild/archive)

**drill-down：**
- cat_cafe_list_session_chain: 列出 session 链
- cat_cafe_read_session_digest: 读 session 摘要
- cat_cafe_read_session_events: 读 session 事件（raw/chat/handoff）
- cat_cafe_read_invocation_detail: 读单次 invocation 全事件

**四肢控制面（Limb — 插件/设备能力调用）：**
- limb_list_available: 列出当前在线节点及能力（含插件提供的服务型节点）
- limb_invoke: 调用节点能力；nodeId 从 limb_list_available 获取，不要猜

**协作工具：**
- cat_cafe_post_message: 本 thread 异步（agent-key 才传 threadId）
- cat_cafe_cross_post_message: 跨 thread（targetCats/行首@二选一）。最小路径：list_threads → cross_post_message(threadId, targetCats, content) → get_thread_context 验证
cat_cafe_register_pr_tracking/cat_cafe_register_issue_tracking/cat_cafe_unregister_tracking
- cat_cafe_get_pending_mentions: @提及
- cat_cafe_get_thread_context: thread 上下文
- cat_cafe_list_threads: thread 摘要
- cat_cafe_create_task: 🧶 毛线球（持久任务）
- cat_cafe_update_task: 更新任务状态
- cat_cafe_create_rich_block: rich block（inline）
- cat_cafe_generate_document: 文档生成→IM投递
- cat_cafe_get_rich_block_rules: rich block 规则
- cat_cafe_multi_mention: 并行拉猫讨论（先搜后问）
- cat_cafe_propose_thread: 提议新建 thread（不直接创建）。返回 proposalId，审批通过后才建；审批前不要 cross_post。可选 projectPath 定子 thread 项目归属（跨 repo 必传；无效 400）。可选 reportingMode：final-only（默认）| none | state-transitions | blocking-ack。triage→none，汇总→final-only。

${RICH_BLOCK_SHORT}
需要富呈现时优先 rich block；首次使用前先 call get_rich_block_rules。
规范：cat-cafe-skills/refs/rich-blocks.md。`;

const ORIGINAL_D8 =
  'A2A 球权检查：@ = 球权转移（行首 @句柄，句中无效）。收到 @ 但对方说"我在动" → 矛盾，push back + 立刻接/退/升（诊断≠解决，说完不@=球还在地上）。收了球却说"你等着/你别动" → 球权死锁，禁止——做不了就退回或升级。球权只有第一人称：只能声明自己持球，不能声明别人持球——没有 @ 或 hold_ball 动作，球权就没转移。';

const CC_TEST = '@铲屎官';
const ORIGINAL_D21 = [
  `下一棒传球决策树（本轮必选其一，缺 = 消息不完整）：先问"下一步谁能做"——`,
  `1. 另一只猫能做 → @句柄（review 完→@author / 修完→@reviewer / merge 完→@愿景守护猫）`,
  `2. 等外部条件（按 2a/2b 判断行动）。外部条件包括：**云端 codex / GitHub bot review / PR check / CI / 长 build / 外部 webhook**——这些不是本地猫，不在 roster，不可 @ 任何本地近似 proxy；CLI 要退出但还需继续也走这条。2a 无回调覆盖（如等 EYES）→ **调用 cat_cafe_hold_ball(...)** + 轮询（口头"我继续"不算）；2b 已有结构化回调且 EYES>0 → 纯事件驱动，**不调用/不续约 hold_ball**（KD-27）`,
  `3. 只有铲屎官本人才能做 → ${CC_TEST}（硬条件：不可逆操作 / 愿景级决策 / 跨猫僵局）`,
  `${CC_TEST} 不是默认出口——先问"哪只猫能接"。反问式 ping 非法（"要不要 X？"/"同意吗？"）：有立场就自决去做（错了能回滚），没立场根本不该 @。**外部 identity（云端 xxx / GitHub bot / CI）** 永远走选项 2（按 2a/2b 判断），严禁投射成本地 @句柄。`,
].join('\n');

// ── Verify S6: Workflow Triggers ─────────────────────────────

console.log('\n🔍 S6: Workflow Triggers');
const wfRaw = readFileSync(join(TEMPLATES, 'workflow-triggers.yaml'), 'utf-8');
const wfParsed = YAML.parse(wfRaw);
for (const breed of ['ragdoll', 'maine-coon', 'siamese']) {
  const loaded = (wfParsed[breed] ?? '').trimEnd();
  assert(`breed=${breed}`, loaded, ORIGINAL_WORKFLOW_TRIGGERS[breed]);
}

// ── Verify S13: MCP Tools Section ────────────────────────────

console.log('\n🔍 S13: MCP Tools Section');
const mcpRaw = readFileSync(join(TEMPLATES, 'mcp-tools.md'), 'utf-8');
const mcpRendered = renderTemplate(stripComments(mcpRaw), { RICH_BLOCK_SHORT });
assert('mcp-tools content', mcpRendered, ORIGINAL_MCP_TOOLS);

// ── Verify D8: A2A Ball Check ────────────────────────────────

console.log('\n🔍 D8: A2A Ball Check');
const d8Raw = readFileSync(join(TEMPLATES, 'a2a-ball-check.md'), 'utf-8');
const d8Content = stripComments(d8Raw);
assert('a2a-ball-check content', d8Content, ORIGINAL_D8);

// ── Verify D21: Handoff Decision Tree ────────────────────────

console.log('\n🔍 D21: Handoff Decision Tree');
const d21Raw = readFileSync(join(TEMPLATES, 'handoff-decision-tree.md'), 'utf-8');
const d21Rendered = renderTemplate(stripComments(d21Raw), { CC_MENTION: CC_TEST });
assert('handoff-decision-tree content', d21Rendered, ORIGINAL_D21);

// ── Summary ──────────────────────────────────────────────────

console.log('');
if (failures > 0) {
  console.error(`❌ ${failures} regression(s) found — template output differs from original`);
  process.exit(1);
} else {
  console.log('✅ Byte-identical compatibility coverage: 4 templates verified (S6, S13, D8, D21)');
  console.log('ℹ️ Additional extracted templates are not byte-compared against historical inline fixtures.');
  console.log('   They are covered by manifest/source existence checks and runtime prompt tests.');
}
