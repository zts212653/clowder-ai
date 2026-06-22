#!/usr/bin/env node
/**
 * F203 Phase B: Compile per-cat L0 string from system-prompt-l0.md template.
 *
 * 13 template variables (per-cat, per-invocation):
 *
 *   Static content (L-segments — from individual template files):
 *   {{L1_CONTENT}}          — [L1] 平行世界自我意识
 *   {{L2_CONTENT}}          — [L2] 客观性 carry-over
 *   {{L3_CONTENT}}          — [L3] 路由规则（传球三选一 + @ 路由）
 *   {{L4_CONTENT}}          — [L4] 五条铁律
 *   {{L5_CONTENT}}          — [L5] MCP 工具索引
 *   {{L6_CONTENT}}          — [L6] 能力唤醒指南
 *   {{L7_CONTENT}}          — [L7] 协作哲学
 *
 *   Dynamic per-cat (≈ S-segment equivalents in non-L0 path):
 *   {{IDENTITY_BLOCK}}      — [S1] 身份声明（name/role/personality/model）
 *   {{USER_CAPSULE}}        — per-user profile capsule (F231): owner portrait + optional primer pointer
 *   {{TEAMMATE_ROSTER}}     — [S5] 队友名册（available cats with @mention/model/strengths）
 *   {{GOVERNANCE_L0}}       — [S9] 治理摘要（from shared-rules.md deterministic extraction）
 *   {{WORKFLOW_TRIGGERS}}   — [S6] 工作流触发点（per-breed workflow triggers）
 *   {{CVO_REF}}             — [S8] 铲屎官引用（co-creator name + mention handles）
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
 * S6 workflow triggers are loaded from assets/prompt-templates/workflow-triggers.yaml
 * with the same .cat-cafe/prompt-overlays/workflow-triggers.local.yaml overlay
 * path as the non-native SystemPromptBuilder path.
 */

import { accessSync, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catRegistry } from '@cat-cafe/shared';
import { getDossierRosterSummary, hasDossierEntry } from '@cat-cafe/shared/dossier';
import YAML from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');
const TEMPLATE_PATH = resolve(REPO_ROOT, 'assets/system-prompts/system-prompt-l0.md');
const PROMPT_TEMPLATES_DIR = resolve(REPO_ROOT, 'assets/prompt-templates');
const PROMPT_OVERLAYS_DIR = resolve(findWorkspaceRoot(process.cwd()), '.cat-cafe', 'prompt-overlays');
const DISPLAY_SEGMENT_LABEL_RE = /^── \[[A-Z]\d+] .+──$/;

/** L1-L7 section template files — static content extracted from the monolithic L0 template. */
const L0_SECTION_TEMPLATES = {
  L1_CONTENT: 'l1-parallel-world.md',
  L2_CONTENT: 'l2-carry-over.md',
  L3_CONTENT: 'l3-routing-rules.md',
  L4_CONTENT: 'l4-iron-laws.md',
  L5_CONTENT: 'l5-mcp-tools-index.md',
  L6_CONTENT: 'l6-capability-wakeup.md',
  L7_CONTENT: 'l7-collaboration-philosophy.md',
};

function findWorkspaceRoot(start) {
  let dir = resolve(start);
  while (dir !== dirname(dir)) {
    if (existsSync(resolve(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = dirname(dir);
  }
  return resolve(start);
}

/**
 * Load an L0 section template file, stripping compiler-only annotation lines.
 * Returns the content with leading/trailing whitespace trimmed.
 */
function loadL0SectionTemplate(filename) {
  const filePath = resolve(PROMPT_TEMPLATES_DIR, filename);
  const raw = readFileSync(filePath, 'utf8');
  return raw
    .split('\n')
    .filter((line) => !isCompilerAnnotationLine(line))
    .join('\n')
    .trim();
}

function isCompilerAnnotationLine(line) {
  const trimmed = line.trim();
  return trimmed.startsWith('<!--') || DISPLAY_SEGMENT_LABEL_RE.test(trimmed);
}

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
// Phase C Task 1 (A8 gap): operator ref handles 必须来自 co-creator config
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

function workflowTriggersBasePath(filename) {
  return resolve(PROMPT_TEMPLATES_DIR, filename);
}

function workflowTriggersOverlayPath(filename) {
  return resolve(PROMPT_OVERLAYS_DIR, filename);
}

function parseWorkflowTriggersFile(filePath) {
  const parsed = YAML.parse(readFileSync(filePath, 'utf-8'));
  if (parsed == null || typeof parsed !== 'object') return {};

  const result = {};
  for (const [breed, content] of Object.entries(parsed)) {
    if (typeof content === 'string') {
      result[breed] = content.trimEnd();
    }
  }
  return result;
}

function loadWorkflowTriggers() {
  const basePath = workflowTriggersBasePath('workflow-triggers.yaml');
  const localPath = workflowTriggersOverlayPath('workflow-triggers.local.yaml');
  const effectivePath = existsSync(localPath) ? localPath : basePath;

  if (!existsSync(effectivePath)) {
    console.warn('[compile-l0] workflow-triggers.yaml not found, using empty map');
    return {};
  }

  try {
    return parseWorkflowTriggersFile(effectivePath);
  } catch (err) {
    console.warn(`[compile-l0] malformed YAML in ${effectivePath}: ${err}`);
    if (effectivePath === localPath && existsSync(basePath)) {
      try {
        return parseWorkflowTriggersFile(basePath);
      } catch {
        console.warn('[compile-l0] base workflow-triggers.yaml also malformed, using empty map');
      }
    }
    return {};
  }
}

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
  // F208 KD-12: dossier l0RosterSummary → legacy teamStrengths → roleDescription
  const dossierSummary = getDossierRosterSummary(id, REPO_ROOT);
  // KD-9: warn only for tracked cats (have dossier entry) missing l0RosterSummary.
  // Runtime/custom cats with no dossier entry silently use config fallback.
  if (!dossierSummary && hasDossierEntry(id, REPO_ROOT)) {
    console.warn(
      `[F208 KD-9] cat "${id}" has dossier entry but missing l0RosterSummary — falling back to config.teamStrengths`,
    );
  }
  const strengths = dossierSummary ?? cfg.teamStrengths ?? cfg.roleDescription;
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
  const workflowTriggers = loadWorkflowTriggers();
  const direct = workflowTriggers[breedId] ?? workflowTriggers[catId];
  if (direct) return direct;
  const familyBreed = DISPLAY_NAME_TO_BREED[displayName];
  if (familyBreed && workflowTriggers[familyBreed]) {
    return workflowTriggers[familyBreed];
  }
  return '## 工作流\n（无 per-breed 触发点配置）';
}

// Phase C Task 1 (A8 gap): 渲染 operator reference 行，对齐 buildStaticIdentity
// L568-571（co-creator config 动态 name + mentionPatterns），替代 L0 §4
// 硬编码 @co-creator。删 user message 后这是猫认 operator + 路由 handle 的唯一来源。
function renderCvoRef() {
  if (!_coCreatorConfig) return '';
  const name = _coCreatorConfig.name;
  const handles = (_coCreatorConfig.mentionPatterns ?? []).map((p) => `\`${p}\``).join(' / ');
  return `${name}（co-creator/operator）。重要决策由${name}拍板。需要关注时行首写 ${handles}。`;
}

// ─── F231: User profile capsule resolution ────────────────────────────────
// Contract (F231 spec KD-7 + Phase A plan §三):
//   profileDir priority: function param > env CAT_CAFE_PROFILE_DIR > default 'private/profile'
//   capsulePath = join(profileDir, 'landy-capsule.md')
//   Three states:
//     missing/unreadable → '' (empty string, no heading — backward compat)
//     ≤300 Unicode chars  → '## 主人画像\n\n{body}' + optional primer pointer
//     >300 Unicode chars  → throw (compilation must fail loudly)
//   Primer pointer: if relationship/{catId}-primer.md exists → append reference line
//   Pointer line does NOT count toward 300-char limit.

const USER_CAPSULE_CHAR_LIMIT = 300;

/**
 * Strip metadata (YAML frontmatter or markdown heading/blockquote metadata)
 * from capsule content. Returns the body after the metadata-terminating `---`.
 *
 * Handles both formats:
 *   YAML:     ---\nkey: val\n---\nbody   → body (after 2nd ---)
 *   Markdown: # Title\n> meta\n---\nbody → body (after 1st ---)
 *
 * If no `---` separator found, returns the entire content trimmed.
 *
 * IMPORTANT (gpt52 review P1): uses FIRST metadata-terminating `---`, NOT last.
 * "Last ---" would silently eat body content if the capsule contains `---`
 * horizontal rules (e.g. "Body one\n---\nBody two" → only "Body two").
 */
function stripCapsuleMetadata(raw) {
  const lines = raw.trim().split('\n');

  // Case 1: YAML frontmatter — starts with `---` on line 0
  if (lines[0].trim() === '---') {
    // Find closing `---` (skip line 0, the opening fence)
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        return lines
          .slice(i + 1)
          .join('\n')
          .trim();
      }
    }
    // Unclosed YAML frontmatter → treat everything after line 0 as body
    return lines.slice(1).join('\n').trim();
  }

  // Case 2: Heading/blockquote metadata (# Title / > meta / ---)
  // Find FIRST `---` separator — that terminates the metadata block
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      return lines
        .slice(i + 1)
        .join('\n')
        .trim();
    }
  }

  // No metadata separator found → return entire content
  return raw.trim();
}

/**
 * Resolve user profile capsule for L0 injection.
 *
 * @param {string} profileDir - directory containing landy-capsule.md
 * @param {string} catId - current cat ID (for primer pointer lookup)
 * @returns {string} formatted injection section, or '' if capsule missing
 * @throws {Error} if capsule exceeds 300 Unicode characters
 */
export function resolveUserCapsule(profileDir, catId) {
  const capsulePath = resolve(profileDir, 'landy-capsule.md');

  // State 1: missing / unreadable → empty (backward compat for community users)
  let raw;
  try {
    raw = readFileSync(capsulePath, 'utf8');
  } catch {
    return '';
  }

  // Strip metadata (YAML frontmatter or markdown heading/blockquote metadata)
  const body = stripCapsuleMetadata(raw);
  if (!body) return '';

  // Count visible characters (Chinese "字数" convention):
  // Letters, CJK chars, punctuation count; whitespace does not.
  // This matches spec intent: "300字" = 300 visible chars, not 300 code points.
  const charCount = [...body.replace(/\s/g, '')].length;

  // State 3: overlong → throw (compilation must fail loudly per KD-7)
  if (charCount > USER_CAPSULE_CHAR_LIMIT) {
    throw new Error(
      `USER_CAPSULE exceeds ${USER_CAPSULE_CHAR_LIMIT}-character limit: ${charCount} characters in ${capsulePath}. ` +
        `Capsule must be ≤${USER_CAPSULE_CHAR_LIMIT} chars (KD-7). Trim content or move overflow to primer.`,
    );
  }

  // State 2: valid → build section with heading
  let section = `## 主人画像\n\n${body}`;

  // Primer pointer: check if relationship/{catId}-primer.md exists
  const primerPath = resolve(profileDir, `relationship/${catId}-primer.md`);
  try {
    accessSync(primerPath);
    // Use standard logical path (not fixture path) for human-readable pointer
    section += `\n\n关系轨迹: private/profile/relationship/${catId}-primer.md（开局可读，按需 recall）`;
  } catch {
    // No primer for this cat — no pointer line
  }

  return section;
}

/**
 * Compile per-cat L0 string by substituting template variables.
 *
 * @param {Object} options
 * @param {string} options.catId - cat ID (must be registered in catRegistry)
 * @param {string} [options.runtimeModel] - resolved runtime model (e.g. claude-opus-4-7)
 * @param {string} [options.profileDir] - override for user profile directory (fixture isolation)
 * @returns {Promise<string>} compiled L0 ready for system-prompt injection
 */
export async function compileL0(options) {
  await bootstrapCatRegistry();
  const { catId, runtimeModel, profileDir } = options;
  const entry = catRegistry.tryGet(catId);
  if (!entry) {
    throw new Error(`compileL0: unknown catId "${catId}". Registered: ${catRegistry.getAllIds().join(', ')}`);
  }
  const config = { ...entry.config, catId };
  // Strip compiler-only annotation lines from the main template (same as
  // loadL0SectionTemplate does for L-section files). Allows rich source labels
  // without changing the compiled output sent to the model.
  const template = readFileSync(TEMPLATE_PATH, 'utf8')
    .split('\n')
    .filter((line) => !isCompilerAnnotationLine(line))
    .join('\n');
  const governanceL0 = await _loadCompiledGovernanceL0(REPO_ROOT);

  // F231: resolve user capsule (profileDir > env > default 'private/profile')
  // Note: REPO_ROOT default only works when script runs from actual project dir.
  // In symlink/packaged layouts, caller (l0-compiler.ts) passes --profile-dir
  // explicitly via subprocess args (gpt52 review P1 fix).
  const resolvedProfileDir = profileDir ?? process.env.CAT_CAFE_PROFILE_DIR ?? resolve(REPO_ROOT, 'private/profile');
  const capsuleSection = resolveUserCapsule(resolvedProfileDir, catId);

  // Load L1-L7 section templates (static content extracted to individual files)
  let result = template;
  for (const [placeholder, filename] of Object.entries(L0_SECTION_TEMPLATES)) {
    result = result.replace(`{{${placeholder}}}`, loadL0SectionTemplate(filename));
  }

  // Dynamic per-cat substitutions
  return result
    .replace('{{IDENTITY_BLOCK}}', buildIdentityBlock(config, runtimeModel))
    .replace('{{USER_CAPSULE}}', capsuleSection)
    .replace('{{TEAMMATE_ROSTER}}', buildTeammateRoster(catId))
    .replace('{{GOVERNANCE_L0}}', governanceL0.content)
    .replace('{{WORKFLOW_TRIGGERS}}', buildWorkflowTriggers(config.breedId, catId, config.displayName))
    .replace('{{CVO_REF}}', renderCvoRef());
}

/**
 * Compile per-cat L0 and write to a file.
 *
 * operator directive 2026-05-15: 完全替换不在 ts/js 硬编码 L0 内容——Phase C
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
//   node scripts/compile-system-prompt-l0.mjs --cat opus-47 --profile-dir /abs/path
//     → override profile directory (gpt52 review P1: fixes symlink/packaged layouts)
if (isCliEntrypoint(import.meta.url, process.argv[1])) {
  const args = process.argv.slice(2);
  const catIdx = args.indexOf('--cat');
  if (catIdx < 0 || !args[catIdx + 1]) {
    console.error(
      'Usage: node scripts/compile-system-prompt-l0.mjs --cat <catId> [--out <path>] [--profile-dir <path>]',
    );
    process.exit(2);
  }
  const catId = args[catIdx + 1];
  const profileDirIdx = args.indexOf('--profile-dir');
  const profileDir = profileDirIdx >= 0 ? args[profileDirIdx + 1] : undefined;
  const outIdx = args.indexOf('--out');
  if (outIdx >= 0 && args[outIdx + 1]) {
    const outPath = args[outIdx + 1];
    await writeL0File({ catId, profileDir }, outPath);
    console.error(`Wrote compiled L0 for ${catId} → ${outPath}`);
  } else {
    process.stdout.write(await compileL0({ catId, profileDir }));
  }
}
