/**
 * F203 Phase E — audit-claude-code-system-prompt.mjs core.
 *
 * "每次 CC/Codex 大版本升级要重拆系统提示词"工具化。extractSections 从
 * `strings <binary>` 输出按已知 section anchor 提取关键段；diffSections
 * 对比上一版本归档，flag 新增功能性指令。fixture 驱动——不依赖真二进制
 * （CI runner 无 claude/codex）。
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ANCHORS_CLAUDE,
  ANCHORS_CODEX,
  codexNativeBinaryCandidates,
  diffSections,
  extractSections,
  formatMarkdown,
  IDENTITY_PATTERNS_CODEX,
  latestArchivedVersion,
  parseCliVersion,
  targetTriple,
} from '../../../scripts/audit-claude-code-system-prompt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = readFileSync(resolve(HERE, 'fixtures/cc-strings-sample.txt'), 'utf8');

test('extractSections pulls identity lines from strings output', () => {
  const r = extractSections(FIXTURE, ANCHORS_CLAUDE);
  assert.ok(
    r.identityLines.some((l) => l.includes("You are Claude Code, Anthropic's official CLI for Claude.")),
    'must capture primary identity line',
  );
  assert.ok(
    r.identityLines.some((l) => l.includes('You are a Claude agent, built on')),
    'must capture agent-SDK identity variant',
  );
});

test('extractSections matches known section anchors, skips binary noise', () => {
  const r = extractSections(FIXTURE, ANCHORS_CLAUDE);
  const ids = r.sections.map((s) => s.id);
  for (const id of ['doing-tasks', 'parallel-tools', 'destructive-safety', 'simple-system-prompt', 'using-tools']) {
    assert.ok(ids.includes(id), `must extract section anchor: ${id}`);
  }
  // binary noise / minified js must NOT become a section
  const allMatched = r.sections.map((s) => s.matchedLine).join('\n');
  assert.ok(!allMatched.includes('randomnoise0xDEADBEEF'), 'noise line must not be matched');
  assert.ok(!allMatched.includes('__webpack_require__'), 'webpack noise must not be matched');
  assert.ok(!allMatched.includes('var Q9=function'), 'minified js must not be matched');
});

test('extractSections flags functional anchors (tool/safety/compact/agent)', () => {
  const r = extractSections(FIXTURE, ANCHORS_CLAUDE);
  const functional = r.sections.filter((s) => s.functional).map((s) => s.id);
  // parallel-tools + destructive-safety + simple-system-prompt are 客观性/功能性
  assert.ok(functional.includes('parallel-tools'), 'parallel tool calls is functional (must carry-over)');
  assert.ok(functional.includes('destructive-safety'), 'destructive safety is functional');
});

test('diffSections: new anchor in current → added (signals L0 carry-over review)', () => {
  const prevDocMarkdown = [
    '# Claude Code v9.9.9 System Prompt 解剖',
    '## 5. section 全清单',
    '- doing-tasks',
    '- parallel-tools',
    '- destructive-safety',
  ].join('\n');
  const current = extractSections(FIXTURE, ANCHORS_CLAUDE); // has simple-system-prompt + using-tools extra
  const d = diffSections(prevDocMarkdown, current);
  assert.ok(Array.isArray(d.added) && d.added.length > 0, 'new anchors must be in added');
  assert.ok(d.added.includes('simple-system-prompt'), 'simple-system-prompt is new vs prev doc');
  assert.ok(d.added.includes('using-tools'), 'using-tools is new vs prev doc');
});

test('diffSections: identical anchor set → no added (no false positive)', () => {
  const current = extractSections(FIXTURE, ANCHORS_CLAUDE);
  const prevDocMarkdown = `## 5. section 全清单\n${current.sections.map((s) => `- ${s.id}`).join('\n')}`;
  const d = diffSections(prevDocMarkdown, current);
  assert.equal(d.added.length, 0, 'same anchor set must not report added');
});

test('parseCliVersion extracts semver from claude/codex --version output', () => {
  assert.equal(parseCliVersion('2.1.143 (Claude Code)', 'claude'), '2.1.143');
  assert.equal(parseCliVersion('codex-cli 0.130.0\n', 'codex'), '0.130.0');
  assert.equal(parseCliVersion('claude 2.10.0 (Claude Code)', 'claude'), '2.10.0');
});

test('latestArchivedVersion picks highest semver from archived filenames', () => {
  const files = [
    'cc-system-prompt-v2.1.142.md',
    'cc-system-prompt-v2.1.143.md',
    'cc-system-prompt-v2.10.0.md',
    'unrelated.md',
    'codex-system-prompt-v0.130.0.md',
  ];
  assert.equal(latestArchivedVersion('claude', files), '2.10.0');
  assert.equal(latestArchivedVersion('codex', files), '0.130.0');
  assert.equal(latestArchivedVersion('claude', ['unrelated.md']), null);
});

test('formatMarkdown produces archived-doc structure (frontmatter + identity + §5 list)', () => {
  const extraction = extractSections(FIXTURE, ANCHORS_CLAUDE);
  const md = formatMarkdown(extraction, { cli: 'claude', version: '2.1.143' });
  assert.ok(md.startsWith('---\n'), 'has YAML frontmatter (ADR-011)');
  assert.ok(/feature_ids:\s*\[F203\]/.test(md), 'frontmatter tags F203');
  assert.ok(md.includes('doc_kind: audit'), 'doc_kind audit');
  assert.ok(md.includes('Claude Code v2.1.143'), 'title carries cli + version');
  assert.ok(md.includes("You are Claude Code, Anthropic's official CLI for Claude."), 'identity line emitted');
  assert.ok(/##\s*\d.*section.*清单|## section list/i.test(md), 'has §5-style section list section');
  for (const id of ['parallel-tools', 'destructive-safety']) {
    assert.ok(md.includes(id), `section list includes functional anchor ${id}`);
  }
  assert.ok(md.includes('functional') || md.includes('客观性'), 'marks functional anchors for carry-over');
});

test('extractSections identity is sentence-bounded (real binary embeds identity in minified blob)', () => {
  // Real `strings $(which claude)` has the identity sentence concatenated
  // inside a 5000+ char minified-JS "line". `[^\n]*` would swallow the whole
  // blob → unreadable §1. Must capture only the sentence + dedupe.
  const r = extractSections(FIXTURE, ANCHORS_CLAUDE);
  for (const l of r.identityLines) {
    assert.ok(l.length < 120, `identity must be sentence-bounded, got ${l.length}: ${l.slice(0, 70)}`);
    assert.ok(!l.includes('WL9='), 'must not capture minified-JS tail');
    assert.ok(/\.$/.test(l), `identity should end at sentence period: "${l}"`);
  }
  const canonical = r.identityLines.filter((l) => l === "You are Claude Code, Anthropic's official CLI for Claude.");
  assert.equal(canonical.length, 1, 'duplicate identity sentences (clean + in-blob) must dedupe to 1');
});

test('targetTriple maps platform/arch like the codex launcher', () => {
  assert.equal(targetTriple('darwin', 'arm64'), 'aarch64-apple-darwin');
  assert.equal(targetTriple('darwin', 'x64'), 'x86_64-apple-darwin');
  assert.equal(targetTriple('linux', 'x64'), 'x86_64-unknown-linux-musl');
  assert.equal(targetTriple('linux', 'arm64'), 'aarch64-unknown-linux-musl');
  assert.equal(targetTriple('win32', 'x64'), 'x86_64-pc-windows-msvc');
  assert.equal(targetTriple('sunos', 'sparc'), null);
});

test('codexNativeBinaryCandidates replicates launcher resolution order', () => {
  // launcher at <pkg>/bin/codex.js → nested platform pkg first, local vendor fallback
  const launcherPath = '/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js';
  const c = codexNativeBinaryCandidates(launcherPath, 'aarch64-apple-darwin');
  assert.ok(Array.isArray(c) && c.length >= 2, 'returns ordered candidate list');
  assert.ok(
    c[0].includes('node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex'),
    `first candidate = nested platform pkg native binary; got ${c[0]}`,
  );
  assert.ok(
    c.some((p) => p.includes('/vendor/aarch64-apple-darwin/codex/codex') && !p.includes('node_modules/@openai/codex-')),
    'includes localVendorRoot fallback',
  );
});

test('codexNativeBinaryCandidates prefers Node-resolved platform pkg (hoisted/sibling install — cloud P1)', () => {
  // Cloud codex review P1: the real codex.js launcher resolves the platform
  // package via Node module resolution (require.resolve), which finds hoisted
  // installs (e.g. pnpm/npm hoisting @openai/codex-<plat> to a parent
  // node_modules). Hardcoded <pkg>/node_modules + <pkg>/vendor candidates miss
  // that valid layout → resolveCliBinary throws. Node-resolved path must come
  // FIRST (mirrors launcher), with the hardcoded candidates kept as fallback.
  const launcher = '/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js';
  const hoistedPkgDir = '/opt/homebrew/lib/node_modules/@openai/codex-darwin-arm64'; // hoisted to parent
  const calls = [];
  const fakeResolve = (pkg, from) => {
    calls.push([pkg, from]);
    return hoistedPkgDir;
  };
  const c = codexNativeBinaryCandidates(launcher, 'aarch64-apple-darwin', fakeResolve);
  assert.deepEqual(calls, [['@openai/codex-darwin-arm64', launcher]], 'resolver anchored at launcher path');
  assert.equal(
    c[0],
    '/opt/homebrew/lib/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex',
    `Node-resolved (hoist-capable) path must be the first candidate; got ${c[0]}`,
  );
  assert.ok(
    c.some((p) =>
      p.includes('@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex'),
    ),
    'hardcoded nested layout retained as fallback (verified-working path not removed)',
  );
  assert.ok(
    c.some((p) => p.endsWith('@openai/codex/vendor/aarch64-apple-darwin/codex/codex')),
    'local vendor fallback retained',
  );
});

test('codexNativeBinaryCandidates falls back to hardcoded candidates when Node resolution fails', () => {
  // Resolver returns null (pkg genuinely not installed) → behavior identical to
  // pre-fix: no crash, hardcoded nested-first ordering preserved.
  const launcher = '/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js';
  const c = codexNativeBinaryCandidates(launcher, 'aarch64-apple-darwin', () => null);
  assert.ok(
    c[0].includes('node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex'),
    `unresolvable → first candidate stays the hardcoded nested path; got ${c[0]}`,
  );
});

test('codex identity patterns match codex identity, not claude', () => {
  const codexStrings = [
    'random noise',
    'You are Codex, based on GPT-5.",X=1;function z(){}junkjunkjunk',
    'You are a coding agent running in the Codex CLI.',
    'developer_instructions',
  ].join('\n');
  const r = extractSections(codexStrings, ANCHORS_CODEX, IDENTITY_PATTERNS_CODEX);
  assert.ok(
    r.identityLines.some((l) => l.startsWith('You are Codex')),
    'captures codex identity',
  );
  for (const l of r.identityLines) {
    assert.ok(l.length < 120 && !l.includes('X=1;function'), 'codex identity also sentence-bounded');
  }
  assert.ok(
    r.sections.some((s) => s.id === 'developer-instructions'),
    'codex anchors still extracted with codex identity patterns',
  );
});

test('round-trip: formatMarkdown output re-parses with zero false drift', () => {
  // P1 (砚砚 BLOCKING): diffSections only parsed bare `- id` lines, but
  // formatMarkdown emits `- id — label · **functional**（...）`. Earlier tests
  // used simplified fake prev-docs so this round-trip break was never caught
  // → every real `--diff` stably false-alarmed all anchors as new FUNCTIONAL.
  const extraction = extractSections(FIXTURE, ANCHORS_CLAUDE);
  const md = formatMarkdown(extraction, { cli: 'claude', version: '2.1.143' });
  const d = diffSections(md, extraction);
  assert.deepEqual(d.added, [], 'formatMarkdown→diffSections must NOT report added (was false-alarming all anchors)');
  assert.deepEqual(d.removed, [], 'formatMarkdown→diffSections must NOT report removed');
});

test('diffSections parses real archived doc format (codex v0.130.0 fixture regression)', () => {
  // Fixture-level regression on the actual shipped archive doc — the exact
  // file 砚砚 reproduced the false-alarm with.
  const realCodexDoc = readFileSync(resolve(HERE, '../../../docs/audits/codex-system-prompt-v0.130.0.md'), 'utf8');
  const codexStrings = ['developer_instructions', 'base_instructions', 'sandbox_mode', 'approval_policy'].join('\n');
  const cur = extractSections(codexStrings, ANCHORS_CODEX, IDENTITY_PATTERNS_CODEX);
  assert.equal(cur.sections.length, 4, 'sanity: current extraction has the 4 codex anchors the doc archived');
  const d = diffSections(realCodexDoc, cur);
  assert.deepEqual(d.added, [], 'real codex archived doc must round-trip with no false added');
  assert.deepEqual(d.removed, [], 'real codex archived doc must round-trip with no false removed');
});

test('diffSections parses hand-written cc baseline §5b (v2.1.143 fixture regression)', () => {
  // cc-v2.1.143 is the pre-existing rich hand doc (prose §5 + §6 evidence).
  // §5b adds a machine-readable ANCHORS_CLAUDE block so it's a valid --diff
  // source (only existing claude archive; SOP step 1). Prose bullets like
  // `- safety = 家规…` must NOT false-parse as anchor-ids (em-dash discriminator).
  const realCcDoc = readFileSync(resolve(HERE, '../../../docs/audits/cc-system-prompt-v2.1.143.md'), 'utf8');
  const cur = extractSections(FIXTURE, ANCHORS_CLAUDE);
  const d = diffSections(realCcDoc, cur);
  assert.deepEqual(d.added, [], 'cc baseline §5b must round-trip with no false added');
  assert.deepEqual(d.removed, [], 'no prose bullet (e.g. "- safety = …") may leak as a removed anchor');
});
