/**
 * F200 HW-4 根因②a — parseShellReadPaths.
 *
 * 砚砚 audit Round 1 + P1-1: real command_execution is NOT bare commands.
 * It is shell-wrapped: `/bin/zsh -lc "sed -n '1,260p' FILE"`,
 * `/bin/zsh -lc 'rg ...'`, multi-segment `sed/nl`. Parser must unwrap the
 * shell wrapper, then parse inner read-only subcommands. rg PATTERN FILE is
 * a content read; `rg --files` / `find` is discovery (not content
 * consumption). 砚砚 P3: unwrap must cover /bin/zsh, /bin/bash, zsh, bash,
 * sh — both absolute and bare.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

describe('F200 HW-4 根因②a: parseShellReadPaths', () => {
  let parseShellReadPaths;
  it('loads the module', async () => {
    const mod = await import(`../../dist/domains/memory/parse-shell-read-paths.js?v=${Date.now()}`);
    parseShellReadPaths = mod.parseShellReadPaths;
    assert.equal(typeof parseShellReadPaths, 'function');
  });

  it('unwraps /bin/zsh -lc and parses sed read (audit real form)', () => {
    const r = parseShellReadPaths(`/bin/zsh -lc "sed -n '1,260p' docs/features/F200-memory-recall-eval.md"`);
    assert.deepEqual(r, ['docs/features/F200-memory-recall-eval.md']);
  });

  it('rg PATTERN FILE inside zsh wrapper is a content read', () => {
    const r = parseShellReadPaths(`/bin/zsh -lc 'rg socio-technical docs/features/F200-memory-recall-eval.md'`);
    assert.ok(r.includes('docs/features/F200-memory-recall-eval.md'), `expected file in ${JSON.stringify(r)}`);
  });

  it('bash -lc nl -ba', () => {
    assert.deepEqual(parseShellReadPaths(`bash -lc 'nl -ba docs/x.md'`), ['docs/x.md']);
  });

  it('multi-segment sed (;) inside wrapper yields all files', () => {
    const r = parseShellReadPaths(`/bin/zsh -lc "sed -n 1,80p a.md; sed -n 1,80p b.md"`);
    assert.deepEqual(r.sort(), ['a.md', 'b.md']);
  });

  it('P3: covers /bin/bash, bare zsh, sh -c forms', () => {
    assert.deepEqual(parseShellReadPaths(`/bin/bash -lc 'sed -n 1,5p a.md'`), ['a.md']);
    assert.deepEqual(parseShellReadPaths(`zsh -lc 'cat a.md'`), ['a.md']);
    assert.deepEqual(parseShellReadPaths(`sh -c 'cat x.md'`), ['x.md']);
  });

  it('bare command without wrapper still works', () => {
    assert.deepEqual(parseShellReadPaths(`cat docs/x.md`), ['docs/x.md']);
    assert.deepEqual(parseShellReadPaths(`sed -n '1,10p' docs/y.md`), ['docs/y.md']);
  });

  it('discovery forms are NOT content reads → []', () => {
    assert.deepEqual(parseShellReadPaths(`/bin/zsh -lc 'rg --files docs | rg foo'`), []);
    assert.deepEqual(parseShellReadPaths(`find docs -name '*.md'`), []);
    assert.deepEqual(parseShellReadPaths(`rg -l pattern docs`), []);
    assert.deepEqual(parseShellReadPaths(`ls docs`), []);
  });

  it('P1 (砚砚 HW-4 review): quote-aware split — rg regex alternation not mis-cut', () => {
    // 砚砚 audit 实测 false negative: 引号内 | 是 regex alternation 不是 shell pipe.
    // 裸 split 会把 "Feat 20|F20|F200" 切碎导致路径漏算 → [].
    assert.deepEqual(parseShellReadPaths(`/bin/zsh -lc 'rg -n "Feat 20|F20|F200" /home/user/MEMORY.md'`), [
      '/home/user/MEMORY.md',
    ]);
    // 回归保护：引号外的 pipe 仍要切（rg --files discovery | rg → 不算消费）
    assert.deepEqual(parseShellReadPaths(`/bin/zsh -lc 'rg --files docs | rg foo'`), []);
    // 引号内 ; 不切（多段判定只认引号外分隔符）
    assert.deepEqual(parseShellReadPaths(`/bin/zsh -lc 'rg -n "a;b" docs/x.md'`), ['docs/x.md']);
  });

  it('P2-1 (云端 codex): extensionless file operands counted (cat Dockerfile / sed LICENSE)', () => {
    // looksLikePath 旧实现要求含 ./ → Dockerfile/Makefile/LICENSE 漏算 false negative
    assert.deepEqual(parseShellReadPaths(`cat Dockerfile`), ['Dockerfile']);
    assert.deepEqual(parseShellReadPaths(`/bin/zsh -lc 'cat Makefile'`), ['Makefile']);
    assert.deepEqual(parseShellReadPaths(`/bin/zsh -lc 'sed -n 1,5p LICENSE'`), ['LICENSE']);
    // 回归：sed-script 仍不当文件；含路径仍正常
    assert.deepEqual(parseShellReadPaths(`sed -n '1,260p' docs/x.md`), ['docs/x.md']);
  });

  it('P2-2 (云端 codex): rg skips option-argument, no false-positive file', () => {
    // rg -g '*.md' PATTERN（无 PATH）→ -g 的 *.md 是 glob option-arg，
    // docs/...md 是 PATTERN 不是 file → 实际没读文件 → []（旧实现假阳性 push F200）
    assert.deepEqual(parseShellReadPaths(`/bin/zsh -lc "rg -g '*.md' docs/features/F200-memory-recall-eval.md"`), []);
    // 有真实 PATH 时仍正确：rg -g '*.md' PATTERN FILE → [FILE]
    assert.deepEqual(parseShellReadPaths(`/bin/zsh -lc "rg -g '*.md' searchpat docs/x.md"`), ['docs/x.md']);
    // 回归：普通 rg PATTERN FILE 不受影响
    assert.deepEqual(parseShellReadPaths(`rg pattern docs/y.md`), ['docs/y.md']);
  });

  it('P2-3 (云端 codex re-review): read-only stderr/stdout redirection NOT a write', () => {
    // sed/cat FILE 2>/dev/null 是只读 + stderr 静默，不是写副作用；
    // 旧 SIDE_EFFECT_RE [<>] 一律 drop → false negative。
    assert.deepEqual(parseShellReadPaths(`/bin/zsh -lc "sed -n '1,100p' docs/x.md 2>/dev/null"`), ['docs/x.md']);
    assert.deepEqual(parseShellReadPaths(`cat docs/y.md 2>/dev/null`), ['docs/y.md']);
    assert.deepEqual(parseShellReadPaths(`/bin/zsh -lc 'rg pattern docs/z.md 2>&1'`), ['docs/z.md']);
    // 回归：真写文件重定向仍当副作用拦
    assert.deepEqual(parseShellReadPaths(`cat a > out.txt`), []);
    assert.deepEqual(parseShellReadPaths(`echo hi >> log`), []);
    assert.deepEqual(parseShellReadPaths(`sed -n 1,5p f.md > dump.txt`), []);
  });

  it('P1 (云端 codex round3): rg -e/-f makes ALL positional operands files (no pattern slice)', () => {
    // rg --help: 用 -e/--regexp 或 -f/--file 时，positional args 全是 files（无 PATTERN slot）
    assert.deepEqual(parseShellReadPaths(`/bin/zsh -lc 'rg -e foo docs/f200.md'`), ['docs/f200.md']);
    assert.deepEqual(parseShellReadPaths(`/bin/zsh -lc 'rg -f patterns.txt docs/x.md'`), ['docs/x.md']);
    assert.deepEqual(parseShellReadPaths(`rg --regexp=foo docs/y.md`), ['docs/y.md']);
    // 回归：无 -e/-f 仍 slice(1) 跳 pattern
    assert.deepEqual(parseShellReadPaths(`rg pattern docs/z.md`), ['docs/z.md']);
  });

  it('P2 (云端 codex round3): side-effect keyword limited to command token, not pattern', () => {
    // 'touch'/'echo' 在 PATTERN 位置（非 cmd）不该拦——只读搜索
    assert.deepEqual(parseShellReadPaths(`rg touch docs/file.md`), ['docs/file.md']);
    assert.deepEqual(parseShellReadPaths(`/bin/zsh -lc 'rg echo docs/x.md'`), ['docs/x.md']);
    // 回归：cmd 位置是写命令仍拦
    assert.deepEqual(parseShellReadPaths(`rm docs/x.md`), []);
    assert.deepEqual(parseShellReadPaths(`mv a.md b.md`), []);
    assert.deepEqual(parseShellReadPaths(`/bin/zsh -lc 'rm docs/x.md'`), []);
  });

  it('云端 codex round4 P1-a: date-prefixed filenames NOT sed-scripts', () => {
    // 旧 isScriptArg `/^[\d$]/` 太宽匹配所有数字开头 token → date-prefixed
    // docs（cat-cafe 常见命名）被误判 sed-script 漏算。
    assert.deepEqual(parseShellReadPaths(`cat 2026-05-18-f200-notes.md`), ['2026-05-18-f200-notes.md']);
    assert.deepEqual(parseShellReadPaths(`/bin/zsh -lc 'sed -n 1,20p 2026-log.md'`), ['2026-log.md']);
    // 回归：sed-script 仍当 script-arg 不当文件
    assert.deepEqual(parseShellReadPaths(`sed -n 1,260p docs/x.md`), ['docs/x.md']);
    assert.deepEqual(parseShellReadPaths(`sed -n '1,80p' a.md`), ['a.md']);
    assert.deepEqual(parseShellReadPaths(`sed 5d a.md`), ['a.md']);
    assert.deepEqual(parseShellReadPaths(`sed '$d' a.md`), ['a.md']);
  });

  it('write / side-effecting commands → []', () => {
    assert.deepEqual(parseShellReadPaths(`/bin/zsh -lc 'rm docs/x.md'`), []);
    assert.deepEqual(parseShellReadPaths(`cat a > out.txt`), []);
    assert.deepEqual(parseShellReadPaths(`mv a.md b.md`), []);
    assert.deepEqual(parseShellReadPaths(`echo hi >> log`), []);
  });

  it('mixed segment: content read + discovery → only the read path', () => {
    const r = parseShellReadPaths(`/bin/zsh -lc "sed -n 1,10p real.md; rg --files docs"`);
    assert.deepEqual(r, ['real.md']);
  });
});
