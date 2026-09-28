#!/usr/bin/env node

/**
 * F056 UI pictograph debt-freeze guard.
 *
 * Existing raw pictographs remain legacy debt, but a changed production UI line
 * may not introduce another one. Designed SVG icons are the canonical replacement.
 * Compatibility parsers must live in non-TSX modules; production JSX/TSX has no
 * parser escape because a diff line cannot prove that an expression is not rendered.
 * Non-semantic paw copy has its own narrowly-scoped annotation.
 */

import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const PICTOGRAPH_PATTERN = /[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu;
const REASONED_PAW_EXPRESSION_ALLOW = /cafe-ui-paw-expression-allow:\s+\S.{8,}$/u;

function isProductionUiPath(file) {
  if (!file || !/^packages\/web\/src\/.+\.(?:jsx|tsx)$/u.test(file)) return false;
  return !/(?:^|\/)(?:__tests__|__fixtures__)(?:\/|$)|\.(?:spec|test|stories)\.[jt]sx$/u.test(file);
}

function uniquePictographs(text) {
  return [...new Set(text.match(PICTOGRAPH_PATTERN) ?? [])];
}

function isAllowedPawExpression(text, pictographs) {
  if (!REASONED_PAW_EXPRESSION_ALLOW.test(text) || !pictographs.every((glyph) => glyph === '🐾')) {
    return false;
  }

  const renderedCopy = text.match(/>([^<]*🐾[^<]*)<\//u)?.[1] ?? '';
  return /[\p{Letter}\p{Number}]/u.test(renderedCopy.replaceAll('🐾', ''));
}

function selectDiffFile(state, diffLine) {
  const match = diffLine.match(/^\+\+\+ b\/(.+)$/u);
  if (!match) return false;
  state.currentFile = match[1];
  state.newLine = null;
  return true;
}

function selectDiffHunk(state, diffLine) {
  const match = diffLine.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
  if (!match) return false;
  state.newLine = Number(match[1]);
  return true;
}

function consumeDiffContentLine(state, diffLine) {
  if (state.newLine === null || diffLine.startsWith('\\')) return null;
  if (diffLine.startsWith('-') && !diffLine.startsWith('---')) return null;

  const isAdded = diffLine.startsWith('+') && !diffLine.startsWith('+++');
  const line = state.newLine;
  if (!diffLine.startsWith('-')) state.newLine += 1;
  if (!isAdded) return null;

  return { file: state.currentFile, line, text: diffLine.slice(1) };
}

export function findAddedUiPictographs(diffText) {
  const findings = [];
  const state = { currentFile: null, newLine: null };

  for (const diffLine of diffText.split('\n')) {
    if (selectDiffFile(state, diffLine) || selectDiffHunk(state, diffLine)) continue;
    const addedLine = consumeDiffContentLine(state, diffLine);
    if (!addedLine || !isProductionUiPath(addedLine.file)) continue;

    const pictographs = uniquePictographs(addedLine.text);
    const isNarrowlyAllowed = isAllowedPawExpression(addedLine.text, pictographs);
    if (pictographs.length > 0 && !isNarrowlyAllowed) {
      findings.push({ ...addedLine, pictographs, text: addedLine.text.trim() });
    }
  }

  return findings;
}

function runGit(args) {
  try {
    return execFileSync('git', args, {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    });
  } catch (error) {
    const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr ?? '').trim() : '';
    throw new Error(`git ${args.join(' ')} failed${stderr ? `: ${stderr}` : ''}`, { cause: error });
  }
}

function readDiff(base) {
  if (base) return runGit(['diff', '--unified=0', `${base}...HEAD`]);

  const staged = runGit(['diff', '--cached', '--unified=0']);
  const unstaged = runGit(['diff', '--unified=0']);
  const workingTree = [staged, unstaged].filter(Boolean).join('\n');
  if (workingTree.trim()) return workingTree;

  return runGit(['diff', '--unified=0', 'origin/main...HEAD']);
}

function parseBase(argv) {
  const index = argv.indexOf('--base');
  if (index === -1) return null;
  return argv[index + 1] ?? null;
}

function main() {
  let diffText;
  try {
    diffText = readDiff(parseBase(process.argv.slice(2)));
  } catch (error) {
    console.error('[check:no-new-ui-emoji] FAIL — unable to read git diff');
    console.error(`  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
    return;
  }

  const findings = findAddedUiPictographs(diffText);
  if (findings.length === 0) {
    console.log('[check:no-new-ui-emoji] PASS — no new raw UI pictographs');
    return;
  }

  console.error('[check:no-new-ui-emoji] FAIL — production UI must use designed SVG icons');
  for (const finding of findings) {
    console.error(`  ${finding.file}:${finding.line} ${finding.pictographs.join(' ')}  ${finding.text}`);
  }
  console.error('  Replace semantic glyphs with project SVG icons.');
  console.error('  Move compatibility parsing to a non-TSX module; expressive paw copy has its own narrow annotation.');
  process.exitCode = 1;
}

if (resolve(process.argv[1] ?? '') === SCRIPT_PATH) main();
