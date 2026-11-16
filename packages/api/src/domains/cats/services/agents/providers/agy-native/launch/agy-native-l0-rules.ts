import { lstatSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { deploymentDefaults } from '@cat-cafe/shared';

/** Keep well below AGY CLI 1.5.x's 24,000-byte per-rule file ceiling. */
export const MAX_AGY_RULE_BODY_BYTES = 16_000;
const RULE_FILE_PREFIX = 'cat-cafe-l0-';

const AUTHORITATIVE_L0_HEADER = [
  `[${deploymentDefaults.brand.displayName} 当前生效原生配置（本轮实时刷新）]`,
  '以下 cat-cafe-l0 规则块由宿主在本轮实时编译并注入原生 systemInstruction，承载当前成员最新的身份、昵称、职责边界、家规、主人画像、队友名册与能力指引。',
  '若本会话首轮冻结的 <System Prompt> 或早期历史上下文中的可变身份、昵称、限制或指引与本规则不一致，一律以本组当前规则为准；工具、目录与圣域边界由当轮宿主执行层实时强制。',
].join('\n');

function lstatIfPresent(path: string) {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function ensureIsolatedDirectory(path: string): void {
  const stat = lstatIfPresent(path);
  if (stat?.isSymbolicLink()) throw new Error(`AGY native profile path must not be a symlink: ${path}`);
  if (stat && !stat.isDirectory()) throw new Error(`AGY native profile path must be a directory: ${path}`);
  if (!stat) mkdirSync(path, { mode: 0o700 });
}

function fenceMarker(line: string): { kind: '`' | '~'; opening: string } | null {
  const trimmed = line.trimStart();
  const match = trimmed.match(/^(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  const kind = match[1][0] as '`' | '~';
  return { kind, opening: trimmed };
}

function splitLongLineUtf8(line: string, maxBytes: number): string[] {
  if (Buffer.byteLength(line, 'utf8') <= maxBytes) return [line];
  const segments: string[] = [];
  let current = '';
  let currentBytes = 0;
  for (const ch of Array.from(line)) {
    const chBytes = Buffer.byteLength(ch, 'utf8');
    if (current && currentBytes + chBytes > maxBytes) {
      segments.push(current);
      current = ch;
      currentBytes = chBytes;
    } else {
      current += ch;
      currentBytes += chBytes;
    }
  }
  if (current) segments.push(current);
  return segments;
}

/** Deterministically partition L0 markdown into UTF-8 byte-bounded, fence-safe chunks. */
export function partitionAgyNativeL0Markdown(markdown: string, maxBodyBytes = MAX_AGY_RULE_BODY_BYTES): string[] {
  const normalized = markdown.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];
  const safeLimit = Math.max(512, maxBodyBytes);
  const chunks: string[] = [];
  let currentLines: string[] = [];
  let currentBytes = 0;
  let activeFence: { kind: '`' | '~'; opening: string; closing: string } | null = null;

  const flush = () => {
    if (currentLines.length === 0) return;
    if (activeFence) currentLines.push(activeFence.closing);
    chunks.push(currentLines.join('\n'));
    currentLines = activeFence ? [activeFence.opening] : [];
    currentBytes = activeFence ? Buffer.byteLength(`${activeFence.opening}\n`, 'utf8') : 0;
  };

  for (const rawLine of normalized.split('\n')) {
    const marker = fenceMarker(rawLine);
    const fenceClosingAllowance = activeFence ? Buffer.byteLength(`\n${activeFence.closing}`, 'utf8') : 0;
    const effectiveLineLimit = Math.max(256, safeLimit - fenceClosingAllowance - 64);
    const pieces = marker ? [rawLine] : splitLongLineUtf8(rawLine, effectiveLineLimit);

    for (const piece of pieces) {
      const pieceBytes = Buffer.byteLength(`${piece}\n`, 'utf8');
      if (currentLines.length > 0 && currentBytes + pieceBytes + fenceClosingAllowance > safeLimit) {
        flush();
      }
      currentLines.push(piece);
      currentBytes += pieceBytes;
    }

    if (marker) {
      if (!activeFence) {
        const fenceRun = marker.opening.match(/^(`{3,}|~{3,})/)?.[1] ?? (marker.kind === '`' ? '```' : '~~~');
        activeFence = { kind: marker.kind, opening: marker.opening, closing: fenceRun };
      } else if (activeFence.kind === marker.kind) {
        activeFence = null;
      }
    }
  }

  if (currentLines.length > 0 && !(activeFence && currentLines.length === 1)) {
    if (activeFence) currentLines.push(activeFence.closing);
    chunks.push(currentLines.join('\n'));
  }
  return chunks;
}

export function materializeAgyNativeL0Rules(input: {
  readonly profileHome: string;
  readonly catId: string;
  readonly systemPrompt: string;
  readonly readOnly?: boolean;
}): {
  readonly rulePaths: readonly string[];
  readonly renderedRules: string;
} {
  const suppliedHome = resolve(input.profileHome);
  if (lstatSync(suppliedHome).isSymbolicLink()) throw new Error('AGY native profile HOME must not be a symlink');
  if (suppliedHome === resolve(homedir())) throw new Error('AGY native rules require an isolated profile HOME');

  let rulesDir = suppliedHome;
  for (const segment of ['.gemini', 'config', 'rules']) {
    rulesDir = join(rulesDir, segment);
    ensureIsolatedDirectory(rulesDir);
  }
  for (const entry of readdirSync(rulesDir)) {
    if (entry.startsWith(RULE_FILE_PREFIX)) {
      rmSync(join(rulesDir, entry), { force: true });
    }
  }

  const executionNote = input.readOnly
    ? '\n[当轮宿主执行策略：read_only —— 本轮仅允许只读文件检查，写文件、命令执行与 MCP 调用均已在宿主执行层禁用。]'
    : '';
  const fullStream = `${AUTHORITATIVE_L0_HEADER}${executionNote}\n\n${input.systemPrompt.replace(/\r\n/g, '\n').trim()}`;
  const chunks = partitionAgyNativeL0Markdown(fullStream, MAX_AGY_RULE_BODY_BYTES);

  const rulePaths: string[] = [];
  const renderedDocs: string[] = [];
  chunks.forEach((chunk, index) => {
    const seq = String(index + 1).padStart(3, '0');
    const filePath = join(rulesDir, `${RULE_FILE_PREFIX}${seq}.md`);
    const doc = [
      '---',
      'trigger: always_on',
      `description: ${JSON.stringify(`${deploymentDefaults.brand.name} canonical L0 (${input.catId} part ${index + 1}/${chunks.length})`)}`,
      '---',
      chunk,
      '',
    ].join('\n');
    writeFileSync(filePath, doc, { encoding: 'utf8', mode: 0o600 });
    rulePaths.push(filePath);
    renderedDocs.push(doc);
  });

  return {
    rulePaths,
    renderedRules: renderedDocs.join('\n'),
  };
}
