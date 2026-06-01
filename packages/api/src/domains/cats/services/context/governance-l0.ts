import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findMonorepoRoot } from '../../../../utils/monorepo-root.js';

/**
 * Derive the install root from this module's file path.
 * governance-l0.ts lives at packages/api/src/domains/cats/services/context/
 * → dist layout: packages/api/dist/domains/cats/services/context/governance-l0.js
 * → 7 levels up from __filename reaches the install root.
 * Used as fallback when reading through AppData mirror junctions fails.
 */
function deriveInstallRoot(): string | null {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    // packages/api/dist/domains/cats/services/context/governance-l0.js
    //    7       6    5      4      3      2        1          0
    return resolve(dirname(thisFile), '..', '..', '..', '..', '..', '..', '..');
  } catch {
    return null;
  }
}

export type GovernanceL0Source = 'base' | 'local' | 'override';

export interface CompiledGovernanceL0 {
  content: string;
  sourcePath: string;
  source: GovernanceL0Source;
  overlayPath: string | null;
  generatedFrom: 'cat-cafe-skills/refs/shared-rules.md';
}

export const SHARED_RULES_RELPATH = 'cat-cafe-skills/refs/shared-rules.md';

function localPaths(basePath: string) {
  const dir = dirname(basePath);
  const ext = extname(basePath);
  const stem = basename(basePath, ext);
  return {
    override: join(dir, `${stem}.local-override${ext}`),
    local: join(dir, `${stem}.local${ext}`),
  };
}

async function tryRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT: file genuinely missing.
    // UNKNOWN: Windows NTFS junction not yet usable on first boot after
    // installation — treat as absent; the junction resolves on next launch.
    if (code === 'ENOENT' || code === 'UNKNOWN') return null;
    throw err;
  }
}

function tryReadSync(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf-8');
}

function normalizeInline(text: string): string {
  return text.replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, ' ').trim();
}

function assertPresent(markdown: string, needle: string): void {
  if (!markdown.includes(needle)) {
    throw new Error(`compileGovernanceL0: missing required shared-rules anchor "${needle}"`);
  }
}

function extractProtocolLabel(markdown: string, coreAnchor: string): string {
  const matches = [...markdown.matchAll(/^###\s+(.+)$/gm)]
    .map((match) => normalizeInline(match[1] ?? ''))
    .filter((heading) => heading.includes(coreAnchor));
  if (matches.length === 0) {
    throw new Error(`compileGovernanceL0: missing required shared-rules anchor "${coreAnchor}"`);
  }
  if (matches.length > 1) {
    throw new Error(`compileGovernanceL0: duplicate required shared-rules anchor "${coreAnchor}"`);
  }
  return (
    matches[0]
      ?.replace(/\s*（[^）]*）\s*$/, '')
      .replace(/协议$/, '')
      .trim() ?? ''
  );
}

function extractFirstParagraphAfterHeading(markdown: string, heading: string): string {
  const start = markdown.indexOf(heading);
  if (start < 0) {
    throw new Error(`compileGovernanceL0: missing required shared-rules heading "${heading}"`);
  }
  const bodyStart = start + heading.length;
  const nextHeading = markdown.slice(bodyStart).search(/\n##\s+/);
  const body = nextHeading >= 0 ? markdown.slice(bodyStart, bodyStart + nextHeading) : markdown.slice(bodyStart);
  const paragraph = body
    .trim()
    .split(/\n\s*\n/)
    .map((part) => normalizeInline(part))
    .find((part) => part.length > 0);
  if (!paragraph) {
    throw new Error(`compileGovernanceL0: empty required shared-rules heading "${heading}"`);
  }
  return paragraph;
}

function extractNumberedHeadings(markdown: string, prefix: 'P' | 'W', expected: number): string[] {
  const re = new RegExp(`^###\\s+(${prefix}[1-${expected}])\\.\\s+(.+)$`, 'gm');
  const byKey = new Map<string, string[]>();
  for (const match of markdown.matchAll(re)) {
    const key = match[1] ?? '';
    const text = normalizeInline(match[2] ?? '');
    const values = byKey.get(key) ?? [];
    values.push(`- **${key}** ${text}`);
    byKey.set(key, values);
  }
  const ordered: string[] = [];
  for (let i = 1; i <= expected; i += 1) {
    const key = `${prefix}${i}`;
    const values = byKey.get(key) ?? [];
    if (values.length === 0) {
      throw new Error(`compileGovernanceL0: missing ${prefix} heading ${key}`);
    }
    if (values.length > 1) {
      throw new Error(`compileGovernanceL0: duplicate ${prefix} heading ${key}`);
    }
    ordered.push(values[0] ?? '');
  }
  return ordered;
}

function extractMagicWords(markdown: string): string[] {
  const rows = [...markdown.matchAll(/^\|\s*「([^」]+)」\s*\|\s*([^|]+?)\s*\|\s*([^|]+?)\s*\|$/gm)]
    .filter((m) => !m[1]?.includes('拉闸词'))
    .map((m) => `-「${normalizeInline(m[1] ?? '')}」= ${normalizeInline(m[2] ?? '')} → ${normalizeInline(m[3] ?? '')}`);
  if (rows.length < 9) {
    throw new Error(`compileGovernanceL0: expected ≥9 Magic Words rows, found ${rows.length}`);
  }
  return rows;
}

/**
 * Deterministic projection from shared-rules.md into the compact always-on
 * governance L0 block. This is intentionally not a summarizer: required
 * headings/table anchors must exist, and missing anchors fail closed.
 */
export function compileGovernanceL0FromMarkdown(markdown: string): string {
  for (const anchor of [
    '## Rule 0',
    '### Push Back 协议',
    '## 第一性原理',
    '## 世界观',
    '## Magic Words',
    '## 10. @ 路由与球权',
    '## 14. 共享状态文件只在 main 改',
    '## 16. 实事求是',
    '### 46 hotfix 标签 + 跨猫升级 review',
    'fallback 层数检测协议',
    '创意-实现解耦协议',
    '## 0. 身份契约',
  ]) {
    assertPresent(markdown, anchor);
  }

  const principles = extractNumberedHeadings(markdown, 'P', 5);
  const worldviews = extractNumberedHeadings(markdown, 'W', 8);
  const magicWords = extractMagicWords(markdown);
  const identityContract = extractFirstParagraphAfterHeading(markdown, '## 0. 身份契约');
  const fallbackProtocolLabel = extractProtocolLabel(markdown, 'fallback 层数检测协议');
  const creativeProtocolLabel = extractProtocolLabel(markdown, '创意-实现解耦协议');

  return [
    '## 3. 家规（shared-rules.md）',
    'Rule 0: 规则是边界不是全部。边界之内保留判断力；认为不适用时用证据说话。Push Back 协议：证据 + 适用性论证 + 替代方案。判断力三问：我现在在做什么 / 我的信息源可靠吗 / 方案感觉笨重？',
    '',
    '### 第一性原理 P1-P5',
    ...principles,
    '',
    '### 世界观 W1-W8',
    ...worldviews,
    '',
    '### 纪律',
    `- 身份契约：${identityContract}`,
    '- 用自己的身份签名 `[昵称/模型🐾]`，签名必须含模型型号；commit body 写 Why。',
    '- 实事求是：结论必须基于多源证据（代码 / commit / PR / 文档）；没查完就说还没查完。',
    '- @ 是路由指令；收到 @ 后三选一：接 / 退 / 升。状态描述不是球权声明。',
    '- 球权只有第一人称；唯一凭据是 @ 或 hold_ball 动作本身。',
    '- 等外部条件走 `cat_cafe_hold_ball(...)` 或结构化回调，不把云端 / GitHub bot 投射成本地猫。',
    '- 共享状态文件只在 main 改，改完立刻 `git commit + git push`。',
    '- 跨 thread 阻塞依赖双写到可追溯状态；消息不是真相源。',
    '',
    '### 质量覆盖',
    '- Bug 先定位根因再修；不确定方向：停 → 搜 → 问 → 确认 → 再动手。',
    '- “完成”附证据；Bug 先红后绿；scope 失控要记录并沉淀。',
    '- 被铲屎官纠正理解偏差时，先完成实际任务，再按 self-evolution 归档偏差根因。',
    '',
    '### Magic Words（铲屎官专用拉闸词 — 仅铲屎官当前指令触发）',
    ...magicWords,
    '',
    '### 治理协议（per-family）',
    '- 46 hotfix 止血：fix/hotfix/quick fix/minimal fix/band-aid/temp/workaround → hotfix；跨猫 review 铁律：hotfix PR 必须跨族或同族不同个体 review，不允许 self-merge；2 周升级 review 三选一。',
    `- ${fallbackProtocolLabel}：同一文件新增 ≥3 层 fallback → 坐标系自检、替代方案评估、说明每层为何不能去掉。`,
    `- ${creativeProtocolLabel}：发现问题 ≠ 动手实现；记录 + handoff；白名单外代码改动需要 Dry Run Gate。`,
  ].join('\n');
}

export async function loadCompiledGovernanceL0(root = findMonorepoRoot()): Promise<CompiledGovernanceL0> {
  const sourcePath = join(root, SHARED_RULES_RELPATH);
  const paths = localPaths(sourcePath);

  const override = await tryRead(paths.override);
  if (override !== null) {
    return {
      content: override.trimEnd(),
      sourcePath,
      source: 'override',
      overlayPath: paths.override,
      generatedFrom: SHARED_RULES_RELPATH,
    };
  }

  let base: string;
  let effectiveSourcePath = sourcePath;
  try {
    base = await readFile(sourcePath, 'utf-8');
  } catch (primaryErr) {
    // On Windows desktop installs, the project dir lives in AppData and uses
    // NTFS junctions pointing back to the install directory. On the very first
    // launch after installation the junction can fail with UNKNOWN even though
    // the link entry and target both exist. Fall back to reading directly from
    // the install root (derived from this module's file path) so the API can
    // boot instead of crashing.
    const installRoot = deriveInstallRoot();
    if (installRoot) {
      const fallbackPath = join(installRoot, SHARED_RULES_RELPATH);
      try {
        base = await readFile(fallbackPath, 'utf-8');
        effectiveSourcePath = fallbackPath;
        // eslint-disable-next-line no-console
        console.warn(
          `[governance-l0] Primary path failed (${(primaryErr as Error).message}), ` +
            `fell back to install root: ${fallbackPath}`,
        );
      } catch {
        throw primaryErr; // Both paths failed — surface the original error
      }
    } else {
      throw primaryErr;
    }
  }

  const compiled = compileGovernanceL0FromMarkdown(base);
  const local = await tryRead(paths.local);
  if (local !== null) {
    return {
      content: `${compiled}\n\n### 本地治理覆盖（shared-rules.local.md）\n${local.trimEnd()}`,
      sourcePath: effectiveSourcePath,
      source: 'local',
      overlayPath: paths.local,
      generatedFrom: SHARED_RULES_RELPATH,
    };
  }

  return {
    content: compiled,
    sourcePath: effectiveSourcePath,
    source: 'base',
    overlayPath: null,
    generatedFrom: SHARED_RULES_RELPATH,
  };
}

export function loadCompiledGovernanceL0Sync(root = findMonorepoRoot()): CompiledGovernanceL0 {
  const sourcePath = join(root, SHARED_RULES_RELPATH);
  const paths = localPaths(sourcePath);

  const override = tryReadSync(paths.override);
  if (override !== null) {
    return {
      content: override.trimEnd(),
      sourcePath,
      source: 'override',
      overlayPath: paths.override,
      generatedFrom: SHARED_RULES_RELPATH,
    };
  }

  let base: string;
  let effectiveSourcePath = sourcePath;
  try {
    base = readFileSync(sourcePath, 'utf-8');
  } catch (primaryErr) {
    // On Windows desktop installs, the project dir lives in AppData and uses
    // NTFS junctions pointing back to the install directory. On the very first
    // launch after installation the junction can fail with UNKNOWN even though
    // the link entry and target both exist. Fall back to reading directly from
    // the install root (derived from this module's file path) so the API can
    // boot instead of crashing at module load time.
    const installRoot = deriveInstallRoot();
    if (installRoot) {
      const fallbackPath = join(installRoot, SHARED_RULES_RELPATH);
      try {
        base = readFileSync(fallbackPath, 'utf-8');
        effectiveSourcePath = fallbackPath;
        // eslint-disable-next-line no-console
        console.warn(
          `[governance-l0] Primary path failed (${(primaryErr as Error).message}), ` +
            `fell back to install root: ${fallbackPath}`,
        );
      } catch {
        throw primaryErr; // Both paths failed — surface the original error
      }
    } else {
      throw primaryErr;
    }
  }
  const compiled = compileGovernanceL0FromMarkdown(base);
  const local = tryReadSync(paths.local);
  if (local !== null) {
    return {
      content: `${compiled}\n\n### 本地治理覆盖（shared-rules.local.md）\n${local.trimEnd()}`,
      sourcePath: effectiveSourcePath,
      source: 'local',
      overlayPath: paths.local,
      generatedFrom: SHARED_RULES_RELPATH,
    };
  }

  return {
    content: compiled,
    sourcePath,
    source: 'base',
    overlayPath: null,
    generatedFrom: SHARED_RULES_RELPATH,
  };
}
