#!/usr/bin/env node
/**
 * F203 Phase B: Compile per-cat L0 string from system-prompt-l0.md template.
 *
 * Template variables (injected per invocation, not statically baked):
 *   {{IDENTITY_BLOCK}}      — catId / displayName / nickname / role / personality / restrictions
 *   {{TEAMMATE_ROSTER}}     — table of other available cats with @mention · model · strengths · caution
 *   {{GOVERNANCE_L0}}       — compact governance block compiled from shared-rules.md
 *   {{WORKFLOW_TRIGGERS}}   — per-breed workflow triggers (ragdoll / maine-coon / siamese)
 *
 * Output: string ready for `claude --system-prompt <out>` or
 * `codex exec -c 'developer_instructions=<out>'`.
 *
 * Usage:
 *   import { compileL0 } from './scripts/compile-system-prompt-l0.mjs';
 *   const l0 = await compileL0({ catId: 'opus-47' });
 *
 * CLI:
 *   node scripts/compile-system-prompt-l0.mjs --cat opus-47
 *
 * TODO(F203/Phase-C): WORKFLOW_TRIGGERS_INLINE is duplicated from
 * SystemPromptBuilder.ts:366. Phase C should export it from the builder
 * and delete the duplicate (P4 single source of truth).
 */

import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const TEMPLATE_PATH = resolve(REPO_ROOT, 'assets/system-prompts/system-prompt-l0.md');

let _bootstrapped = false;
// 云端 review round-2 P1: bootstrap 必须用 no-arg loadCatConfig()——
// 它做 template base + `.cat-cafe/cat-catalog.json` overlay deep merge
// (cat-config-loader.ts:307-327)，反映 runtime 真相（含 disabled 猫）。
// 旧实现 loadCatConfig(CAT_TEMPLATE_PATH) 显式 path 跳过 catalog overlay
// → isCatAvailable 基于 stale template → round-1 P2 fix 实际无效
// （dead-end @ 路由没真正防住）。no-arg DEFAULT 反推 worktree root
// cat-template.json + 同目录 catalog overlay，路径正确。
// 测试隔离：测试可设 process.env.CAT_TEMPLATE_PATH 指向隔离 template。
let _loadedConfig = null;
let _isCatAvailable = null;
let _getCatModel = null;
let _loadCompiledGovernanceL0 = null;
// Phase C Task 1 (A8 gap): CVO ref handles 必须来自 co-creator config
// 渲染（buildStaticIdentity L568-571 同源），非 L0 硬编码 @co-creator——
// 否则删 user message 后 co-creator 多 handle / 自定义 name 丢失。
let _coCreatorConfig = null;
async function bootstrapCatRegistry() {
  if (_bootstrapped) return;
  const { loadCatConfig, toAllCatConfigs, isCatAvailable, getCoCreatorConfig } = await import(
    '../packages/api/dist/config/cat-config-loader.js'
  );
  const { getCatModel } = await import('../packages/api/dist/config/cat-models.js');
  const { loadCompiledGovernanceL0 } = await import(
    '../packages/api/dist/domains/cats/services/context/governance-l0.js'
  );
  _loadedConfig = loadCatConfig(); // no-arg: template + catalog overlay (runtime truth)
  _isCatAvailable = isCatAvailable;
  _getCatModel = getCatModel;
  _loadCompiledGovernanceL0 = loadCompiledGovernanceL0;
  _coCreatorConfig = getCoCreatorConfig(_loadedConfig);
  const allConfigs = toAllCatConfigs(_loadedConfig);
  for (const [id, config] of Object.entries(allConfigs)) {
    if (!catRegistry.has(id)) {
      catRegistry.register(id, config);
    }
  }
  _bootstrapped = true;
}

/**
 * 云端 review P1: 跨平台 CLI 入口检测。
 * 旧实现 `import.meta.url === \`file://${process.argv[1]}\`` 只匹配
 * POSIX 路径；Windows argv1=`C:\...` 而 import.meta.url=`file:///C:/...`
 * → 条件恒 false，CLI path 在 Windows 永不执行。改用 Node 自己的
 * fileURLToPath + resolve 做绝对路径比较（处理相对 argv1 + Windows 盘符）。
 */
export function isCliEntrypoint(metaUrl, argv1) {
  if (!argv1) return false;
  try {
    // Desktop packaged layout: service-manager mirrors scripts/ into a
    // user-writable project dir via symlink (project/scripts → .app/.../
    // Resources/scripts). Node ESM resolves import.meta.url to the real
    // path (inside .app) while process.argv[1] keeps the symlink path
    // → naive comparison always mismatches → CLI entry never fires.
    // realpathSync both sides so symlink vs real path compares correctly.
    return realpathSync(fileURLToPath(metaUrl)) === realpathSync(resolve(argv1));
  } catch {
    return false;
  }
}

/**
 * 云端 review P2: 队友名册只列 available 猫。
 * disabled 猫进 roster → handoff 指令 @ 已下线猫 = dead-end 路由。
 * 纯函数，可注入 isAvailableFn 测试。
 */
export function filterAvailableTeammates(allConfigs, currentCatId, isAvailableFn) {
  return Object.entries(allConfigs).filter(([id]) => id !== currentCatId && isAvailableFn(id));
}

// TODO(F203/Phase-C): replace with `import { WORKFLOW_TRIGGERS } from
// '@cat-cafe/api/.../SystemPromptBuilder'` once exported.
const WORKFLOW_TRIGGERS_INLINE = {
  ragdoll: [
    '## 工作流（主动 @ 触发点）',
    '- 完成开发/修复 → @缅因猫 请 review',
    '- 修完 review 意见 → @缅因猫 确认修复',
    '- 遇到视觉/体验问题 → @暹罗猫 征询',
    '- Review 别人代码：每个发现给明确立场（放行/退回 + 理由）',
    '',
    '### 布偶猫家族治理（46 hotfix 止血 F177 Phase E）',
    'commit/PR title 含 `fix:`/`hotfix:`/`quick fix`/`minimal fix`/`band-aid`/`temp`/`workaround` → 归类 hotfix。单文件 ≤50 行 + 关键词 → 自动加 `hotfix` label。hotfix PR 必须跨猫 review（禁止 self-merge）；quality-gate 禁止作者 self-validate。2 周升级 review cron：升级正式修复 / 接受永久方案 / 已不再相关 三选一。',
  ].join('\n'),
  'maine-coon': [
    '## 工作流（主动 @ 触发点）',
    '- 完成 review → @布偶猫 通知结果',
    '- 修完 bug/feature → @布偶猫 请 review',
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
    '同文件新增 ≥3 层 fallback（`try/catch`/`??`/`||`/`else-if` 级联）→ 坐标系自检：① 修坐标系还是补错误坐标系？② 坐标变换能否消除？③ 每层为什么不能去掉？',
    '',
    '### 长任务纪律（Codex CLI harness 专属）',
    '- `exec_command` 返回 `session_id` = 命令存活；同 `session_id` 续 `write_stdin`，别因暂无输出另起命令。',
    "- 无头 harness 里 `bash &` / `nohup` / `disown` / `setsid` 是伪后台（父进程退出子进程随之死）；真后台用 Node `spawn(..., { detached: true, stdio: 'ignore' })` + `unref()`。",
    '- Fire-and-forget（含 `pnpm gate` / `pnpm test` / merge-gate）必须约定 `pid` / `log` / `exit` 探针——无探针不算启动成功；轮询是验结果不是续命。',
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
    '',
    '### 暹罗猫家族治理（创意-实现解耦 F177 Phase C）',
    '发现问题 ≠ 动手改代码 → 记录 + handoff 执行猫（查 roster）。Edit 白名单：`designs/`/`docs/`/`assets/`/根目录 `.md`。碰 `packages/`/`src/` 必须 handoff。Dry Run Gate：暹罗猫签名 commit 改了白名单外文件 → hook 自动跑 build + test。',
  ].join('\n'),
};

function buildIdentityBlock(config, runtimeModel) {
  const lines = [];
  const nameLabel = config.nickname
    ? `${config.displayName}/${config.nickname}（${config.name}）`
    : `${config.displayName}（${config.name}）`;
  lines.push(`你是 ${nameLabel}。`);
  if (config.nickname) {
    lines.push(`昵称 "${config.nickname}" 的由来见 \`docs/stories/cat-names/\`。`);
  }
  lines.push(`角色：${config.roleDescription}`);
  lines.push(`性格：${config.personality}`);
  // Bug fix: CLI 不传 runtimeModel 导致 L0 缺模型号，猫读 CLAUDE.md 硬编码签名出错。
  // fallback 链：runtimeModel（显式传入）> resolveModel（env override）> defaultModel。
  const resolvedModel = runtimeModel || resolveModel(config.catId ?? '', config);
  if (resolvedModel) {
    lines.push(`Identity constant: \`@${config.catId ?? ''}\` model=${resolvedModel}`);
  }
  if (config.restrictions && config.restrictions.length > 0) {
    lines.push('');
    lines.push(`**硬限制**：${config.restrictions.join('、')}。被 @ 做这类任务时请 push back 或退回给 @ 你的猫。`);
  }
  return lines.join('\n');
}

function rosterLabel(cfg) {
  if (cfg.variantLabel) return `${cfg.displayName} ${cfg.variantLabel}`;
  if (cfg.nickname) return `${cfg.displayName}/${cfg.nickname}`;
  return cfg.displayName;
}

// 云端 review round-2 P2: roster 列标"当前模型"，必须 runtime resolve
// （getCatModel: env CAT_{CATID}_MODEL override > catRegistry），不能用
// 静态 cfg.defaultModel——否则 env model override 下广告错误队友模型，
// 误导 handoff。对齐 SystemPromptBuilder.ts:434（既定 runtime 模式）。
function resolveModel(id, cfg) {
  if (_getCatModel) {
    try {
      return _getCatModel(id);
    } catch {
      // getCatModel throws if cat unknown — fall back to static defaultModel
    }
  }
  return cfg.defaultModel ?? '';
}

function buildRosterRow(id, cfg) {
  const mention = cfg.mentionPatterns?.[0] ?? `@${id}`;
  const model = resolveModel(id, cfg);
  const cell = model ? `${mention} · ${model}` : mention;
  const strengths = cfg.teamStrengths ?? cfg.roleDescription;
  const hasRestrictions = cfg.restrictions && cfg.restrictions.length > 0;
  const restrictions = hasRestrictions ? `**硬限制**：${cfg.restrictions.join('、')}` : null;
  const caution = [cfg.caution ?? null, restrictions].filter(Boolean).join('；') || '—';
  return `| ${rosterLabel(cfg)} | ${cell} | ${strengths} | ${caution} |`;
}

function buildTeammateRoster(currentCatId) {
  const allConfigs = catRegistry.getAllConfigs();
  const teammates = filterAvailableTeammates(
    allConfigs,
    currentCatId,
    (id) => !_isCatAvailable || _isCatAvailable(id, _loadedConfig),
  );
  if (teammates.length === 0) return '（无其他可用队友）';

  const rows = ['## 队友名册', '| 猫猫 | @mention · 当前模型 | 擅长 | 注意 |', '|------|---------|------|------|'];
  for (const [id, cfg] of teammates) {
    rows.push(buildRosterRow(id, cfg));
  }
  return rows.join('\n');
}

// F203 Phase B fix: 现有 SystemPromptBuilder.ts:554 对 breedId 不在
// {ragdoll,maine-coon,siamese} 的 cat（如 opus-47，breedId='opus-47'）
// 无 workflow triggers（既有 gap，S1 baseline 实测 opus-47 workflow=0t）。
// 这里加 displayName→breed fallback 修这个 gap：opus-47 是布偶猫家族，
// 应共享 ragdoll workflow。**行为变更**：见 F203 spec KD-8。
const DISPLAY_NAME_TO_BREED = {
  布偶猫: 'ragdoll',
  缅因猫: 'maine-coon',
  暹罗猫: 'siamese',
};

function buildWorkflowTriggers(breedId, catId, displayName) {
  const direct = WORKFLOW_TRIGGERS_INLINE[breedId] ?? WORKFLOW_TRIGGERS_INLINE[catId];
  if (direct) return direct;
  const familyBreed = DISPLAY_NAME_TO_BREED[displayName];
  if (familyBreed && WORKFLOW_TRIGGERS_INLINE[familyBreed]) {
    return WORKFLOW_TRIGGERS_INLINE[familyBreed];
  }
  return '## 工作流\n（无 per-breed 触发点配置）';
}

// Phase C Task 1 (A8 gap): 渲染 CVO reference 行，对齐 buildStaticIdentity
// L568-571（co-creator config 动态 name + mentionPatterns），替代 L0 §4
// 硬编码 @co-creator。删 user message 后这是猫认 CVO + 路由 handle 的唯一来源。
function renderCvoRef() {
  if (!_coCreatorConfig) return '';
  const name = _coCreatorConfig.name;
  const handles = (_coCreatorConfig.mentionPatterns ?? []).map((p) => `\`${p}\``).join(' / ');
  return `${name}（铲屎官/CVO）。重要决策由${name}拍板。需要关注时行首写 ${handles}。`;
}

/**
 * Compile per-cat L0 string by substituting template variables.
 *
 * @param {Object} options
 * @param {string} options.catId - cat ID (must be registered in catRegistry)
 * @param {string} [options.runtimeModel] - resolved runtime model (e.g. claude-opus-4-7)
 * @returns {Promise<string>} compiled L0 ready for system-prompt injection
 */
export async function compileL0(options) {
  await bootstrapCatRegistry();
  const { catId, runtimeModel } = options;
  const entry = catRegistry.tryGet(catId);
  if (!entry) {
    throw new Error(`compileL0: unknown catId "${catId}". Registered: ${catRegistry.getAllIds().join(', ')}`);
  }
  const config = { ...entry.config, catId };
  const template = readFileSync(TEMPLATE_PATH, 'utf8');
  const governanceL0 = await _loadCompiledGovernanceL0(REPO_ROOT);
  return template
    .replace('{{IDENTITY_BLOCK}}', buildIdentityBlock(config, runtimeModel))
    .replace('{{TEAMMATE_ROSTER}}', buildTeammateRoster(catId))
    .replace('{{GOVERNANCE_L0}}', governanceL0.content)
    .replace('{{WORKFLOW_TRIGGERS}}', buildWorkflowTriggers(config.breedId, catId, config.displayName))
    .replace('{{CVO_REF}}', renderCvoRef());
}

/**
 * Compile per-cat L0 and write to a file.
 *
 * CVO directive 2026-05-15: 完全替换不在 ts/js 硬编码 L0 内容——Phase C
 * 用 `claude --system-prompt-file <path>` 从文件读。compile 渲染 per-cat
 * L0 → 写文件 → spawn 引用文件路径（内容真相源始终是 system-prompt-l0.md）。
 *
 * @param {Object} options - same as compileL0 ({ catId, runtimeModel? })
 * @param {string} outPath - absolute path to write compiled L0
 * @returns {Promise<string>} the compiled L0 (also written to outPath)
 */
export async function writeL0File(options, outPath) {
  const compiled = await compileL0(options);
  writeFileSync(outPath, compiled, 'utf8');
  return compiled;
}

// CLI:
//   node scripts/compile-system-prompt-l0.mjs --cat opus-47            → stdout
//   node scripts/compile-system-prompt-l0.mjs --cat opus-47 --out p.md → write file
if (isCliEntrypoint(import.meta.url, process.argv[1])) {
  const args = process.argv.slice(2);
  const catIdx = args.indexOf('--cat');
  if (catIdx < 0 || !args[catIdx + 1]) {
    console.error('Usage: node scripts/compile-system-prompt-l0.mjs --cat <catId> [--out <path>]');
    process.exit(2);
  }
  const catId = args[catIdx + 1];
  const outIdx = args.indexOf('--out');
  if (outIdx >= 0 && args[outIdx + 1]) {
    const outPath = args[outIdx + 1];
    await writeL0File({ catId }, outPath);
    console.error(`Wrote compiled L0 for ${catId} → ${outPath}`);
  } else {
    process.stdout.write(await compileL0({ catId }));
  }
}
