// @vitest-environment node
/**
 * F056 Design Token Audit — catches hardcoded colors in ALL contexts.
 *
 * The ESLint rule cafe/no-hardcoded-colors only checks JSX className/style
 * literals. This test catches colors stored in variables, maps, and objects
 * that are later interpolated into className — the gap codex identified.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const srcDir = resolve(testDir, '..', '..', '..');

const ALLOWLISTED_PATHS = [
  '__tests__/',
  '.test.',
  'console-shell.css',
  'theme-tokens.css',
  'color-utils.ts',
  'pixel-brawl/',
  'types.ts',
  'story-export/story-data.ts',
];

function collectFiles(dir: string, exts: string[]): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== 'node_modules') {
      results.push(...collectFiles(full, exts));
    } else if (entry.isFile() && exts.some((ext) => entry.name.endsWith(ext))) {
      results.push(full);
    }
  }
  return results;
}

function isAllowlisted(filePath: string): boolean {
  return ALLOWLISTED_PATHS.some((p) => filePath.includes(p));
}

type Hit = { file: string; line: number; match: string };

function scanFiles(pattern: RegExp, excludeMatch?: (token: string) => boolean): Hit[] {
  const globalPattern = new RegExp(pattern.source, 'g');
  const files = collectFiles(resolve(srcDir, 'src'), ['.ts', '.tsx']);
  const hits: Hit[] = [];
  for (const file of files) {
    if (isAllowlisted(file)) continue;
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      if (text.includes('eslint-disable')) continue;
      const prevLine = i > 0 ? lines[i - 1] : '';
      if (prevLine.includes('eslint-disable-next-line')) continue;
      globalPattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = globalPattern.exec(text)) !== null) {
        const token = extractToken(text, m.index);
        if (excludeMatch && excludeMatch(token)) continue;
        hits.push({ file: file.replace(srcDir + '/', ''), line: i + 1, match: token });
      }
    }
  }
  return hits;
}

function extractToken(line: string, matchStart: number): string {
  let start = matchStart;
  while (start > 0 && !/\s|'|"|`/.test(line[start - 1])) start--;
  let end = matchStart;
  while (end < line.length && !/\s|'|"|`/.test(line[end])) end++;
  return line.slice(start, end);
}

function formatHits(hits: Hit[]): string {
  return hits.map((h) => `  ${h.file}:${h.line}: ${h.match}`).join('\n');
}

describe('F056 hardcoded color audit (variable-stored)', () => {
  it('no arbitrary hex colors in Tailwind classes (bg-[#...], text-[#...], accent-[#...], etc.)', () => {
    const pattern =
      /(?:hover:|focus:|active:)?(?:bg|text|border|ring|from|to|via|outline|shadow|accent|fill|stroke)-\[#/;
    const hits = scanFiles(pattern, (token) => token.includes('var(--'));
    expect(hits, `Found hardcoded hex in Tailwind classes:\n${formatHits(hits)}`).toEqual([]);
  });

  it('no non-semantic Tailwind color utilities (bg-red-*, accent-yellow-*, from-amber-*, etc.)', () => {
    const rawColors =
      'green|red|amber|blue|yellow|gray|slate|indigo|purple|teal|violet|pink|rose|orange|cyan|lime|fuchsia';
    const prefixes = 'bg|text|border|ring|from|to|via|outline|accent|fill|stroke';
    const pattern = new RegExp(`(?:${prefixes})-(?:${rawColors})-\\d`);
    const hits = scanFiles(pattern);
    expect(hits, `Found non-semantic Tailwind colors:\n${formatHits(hits)}`).toEqual([]);
  });
});
