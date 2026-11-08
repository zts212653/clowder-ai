import { posix } from 'node:path';
import type { TasteDecisionPayload } from '../../memory/taste/TasteMemoryReader.js';
import { singleLine, withoutTrailingWhitespace } from './taste-text.js';

const DIMENSION_TO_SECTION: Record<string, string> = {
  'relationship-stance': '### 关系姿态',
  'cognitive-honesty': '### 认知诚实',
  'architecture-aesthetics': '### 架构审美',
  'visual-quality': '### 视觉品质',
  'authentic-expression': '### 表达真实',
  'system-philosophy': '### 系统哲学',
  'creative-craft': '### 创作手法',
};

export function projectTasteIndex(
  originalContent: string | null,
  sourcePath: string,
  payload: TasteDecisionPayload | null,
): string {
  const filename = posix.basename(sourcePath);
  const slug = filename.replace(/\.md$/, '');
  const withoutCurrent = removeTasteIndexEntry(
    originalContent ?? '# Taste Index\n\nApproved taste vignettes, organized by dimension.\n',
    filename,
  );
  if (!payload) return withoutCurrent;
  const tags = payload.tags.map(singleLine).filter(Boolean);
  const entry = [
    `- [**${tags[0] ?? slug}**](vignettes/${filename})`,
    `  - 搜索词：${tags.join('、')}`,
    // An 80-character preview; a cut can land on a space, which the end trim removes.
    `  - 场景：${Array.from(singleLine(payload.scene)).slice(0, 80).join('').trimEnd()}`,
  ];
  const section = payload.dimension ? DIMENSION_TO_SECTION[payload.dimension] : undefined;
  const lines = withoutCurrent.split('\n');
  const sectionIndex = section ? lines.findIndex((line) => line.trim() === section) : -1;
  if (sectionIndex >= 0) {
    let insertAt = sectionIndex + 1;
    while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt++;
    while (insertAt < lines.length && (lines[insertAt].startsWith('- ') || lines[insertAt].startsWith('  '))) {
      insertAt++;
    }
    lines.splice(insertAt, 0, '', ...entry);
    return normalizeBlankLines(lines.join('\n'));
  }
  const howTo = lines.findIndex((line) => line.startsWith('## 如何新增'));
  lines.splice(howTo >= 0 ? howTo : lines.length, 0, ...entry, '');
  return normalizeBlankLines(lines.join('\n'));
}

function removeTasteIndexEntry(content: string, filename: string): string {
  const lines = content.split('\n');
  const start = lines.findIndex((line) => line.includes(`](vignettes/${filename})`));
  if (start < 0) return content;
  let end = start + 1;
  while (end < lines.length && (lines[end].startsWith('  ') || lines[end].trim() === '')) end++;
  lines.splice(start, end - start);
  return normalizeBlankLines(lines.join('\n'));
}

function normalizeBlankLines(content: string): string {
  return `${withoutTrailingWhitespace(content)
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
}
