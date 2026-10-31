/**
 * F200 HW-4 根因②a — parse safe read-only shell file reads.
 *
 * audit Round 1 (砚砚 P1-1): real `command_execution` is NOT bare commands —
 * it is shell-wrapped, e.g. `/bin/zsh -lc "sed -n '1,260p' FILE"`,
 * `/bin/zsh -lc 'rg ...'`, multi-segment `sed/nl`. This parser:
 *   1. unwraps the shell wrapper (/bin/zsh, /bin/bash, zsh, bash, sh — 砚砚 P3)
 *   2. splits `;` `&&` `||` `|` segments and parses each
 *   3. treats `sed/nl/cat/head/tail/less/bat` + `rg PATTERN FILE` as content
 *      reads; `rg --files` / `find` / `ls` / `grep` discovery and any
 *      write/side-effect segment yield nothing.
 *
 * Single source of truth — consumed by RecallEventCorrelator (root cause ②a)
 * and TrajectoryAggregator filesRead (root cause ②c).
 */

const WRAPPER_RE = /^\s*(?:\/[\w./-]+\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]+)\1\s*$/;
const READ_CMDS = new Set(['cat', 'sed', 'nl', 'head', 'tail', 'less', 'bat']);
// 云端 codex P2-3: only a redirect to a REAL file is a write side-effect.
// `2>/dev/null` / `>/dev/null` / `2>&1` are read-only stderr/stdout silencing.
const WRITE_REDIRECT_RE = />>?\s*(?!\/dev\/(?:null|stderr|stdout)|&\d)\S/;
// 云端 codex round3 P2: write-cmd keywords are matched at the COMMAND
// POSITION (first token after wrapper unwrap), not anywhere in the segment —
// else a pattern like `rg touch FILE` is mis-classified as side-effecting.
const WRITE_CMDS = new Set(['rm', 'mv', 'cp', 'tee', 'echo', 'touch', 'mkdir', 'chmod', 'dd']);
// 云端 codex P2-2: rg short/long options whose NEXT token is the option value
// (a glob/regexp/type), NOT the PATTERN or a FILE path. Skipping the value
// prevents `-g '*.md'` etc. from being mis-read as a file operand.
const RG_VALUE_OPTS = new Set([
  '-g',
  '--glob',
  '--iglob',
  '-e',
  '--regexp',
  '-t',
  '--type',
  '-T',
  '--type-not',
  '-A',
  '--after-context',
  '-B',
  '--before-context',
  '-C',
  '--context',
  '-m',
  '--max-count',
  '--max-depth',
  '-r',
  '--replace',
  '-f',
  '--file',
]);

function unwrap(command: string): string {
  const m = WRAPPER_RE.exec(command.trim());
  return m ? m[2]! : command;
}

function stripQuotes(t: string): string {
  if (t.length >= 2 && ((t[0] === "'" && t.at(-1) === "'") || (t[0] === '"' && t.at(-1) === '"'))) {
    return t.slice(1, -1);
  }
  return t;
}

// sed/awk-style scripts that are NOT file paths: `1,260p`, `1,80p`, `5d`,
// `$`, `s/a/b/`. 云端 codex round4 P1-a: 旧 `/^[\d$]/` 太宽 → date-prefixed
// 文件名（`2026-05-18-notes.md`）被误判，导致 cat-cafe 常见 docs 命名漏算。
// 改为精确 sed-script 形态（range+cmd / sed substitute / line-address）。
function isScriptArg(t: string): boolean {
  return /^[0-9,]+[a-z]$/.test(t) || /^s\//.test(t) || /^\$[a-z]?$/.test(t);
}

// Quote-aware segment split — only break on shell `;` `|` `||` `&&` that are
// OUTSIDE quotes. 砚砚 HW-4 review P1: real Codex `rg -n "A|B|C" FILE` has the
// `|` inside quotes as regex alternation, not a shell pipe; a naive
// `.split(/;|\|\|?|&&/)` mis-cuts it and the file path is lost (false negative).
function splitSegments(s: string): string[] {
  const segs: string[] = [];
  let cur = '';
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === ';') {
      segs.push(cur);
      cur = '';
      continue;
    }
    if (ch === '|') {
      if (s[i + 1] === '|') i++;
      segs.push(cur);
      cur = '';
      continue;
    }
    if (ch === '&' && s[i + 1] === '&') {
      i++;
      segs.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  segs.push(cur);
  return segs;
}

export function parseShellReadPaths(command: string): string[] {
  if (!command || typeof command !== 'string') return [];
  const inner = unwrap(command);
  const segments = splitSegments(inner);
  const out: string[] = [];

  for (const rawSeg of segments) {
    const seg = rawSeg.trim();
    if (!seg) continue;
    if (WRITE_REDIRECT_RE.test(seg)) continue; // any-position write redirect (`> file`, `>> log`)

    const toks = (seg.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map(stripQuotes);
    if (toks.length === 0) continue;
    const cmd = toks[0]!.split('/').pop() ?? toks[0]!;
    if (WRITE_CMDS.has(cmd)) continue; // cmd-position write command (rm/mv/cp/...)

    if (cmd === 'rg') {
      // discovery forms are not content consumption
      if (toks.some((t) => t === '--files' || t === '-l' || t === '--files-with-matches')) continue;
      // 云端 codex P2-2: skip option-arguments (e.g. `-g '*.md'`) so the
      // glob/regexp value isn't mis-read as PATTERN/FILE. rg grammar:
      // `rg [opts] PATTERN [PATH...]` → operands[0]=pattern, rest=file paths.
      // 云端 codex round3 P1: -e/--regexp / -f/--file PROVIDE the pattern → all
      // positional operands become files (no positional pattern slot). Source:
      // `rg --help`: "When -f/--file or -e/--regexp is used, then ripgrep
      // treats all positional arguments as files or directories to search."
      const rest = toks.slice(1);
      const hasPatternProvidingOpt = rest.some(
        (t) =>
          t === '-e' ||
          t === '--regexp' ||
          t === '-f' ||
          t === '--file' ||
          t.startsWith('--regexp=') ||
          t.startsWith('--file='),
      );
      const operands: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        const t = rest[i]!;
        if (t.startsWith('--') && t.includes('=')) continue; // --glob=*.md / --regexp=foo
        if (RG_VALUE_OPTS.has(t)) {
          i++; // skip this option AND its value token
          continue;
        }
        if (t.startsWith('-')) continue; // other valueless flags (-n, -i, ...)
        if (/[<>]/.test(t)) continue; // redirect artifact (2>/dev/null, 2>&1)
        operands.push(t);
      }
      const fileOperands = hasPatternProvidingOpt ? operands : operands.slice(1);
      for (const f of fileOperands) out.push(f);
      continue;
    }
    if (cmd === 'find' || cmd === 'ls' || cmd === 'grep') continue;

    if (READ_CMDS.has(cmd)) {
      // 云端 codex P2-1: file operands need not contain `.` or `/`
      // (cat Dockerfile / sed LICENSE). Non-flag + non-script-arg = file.
      for (const t of toks.slice(1)) {
        if (t.startsWith('-')) continue;
        if (/[<>]/.test(t)) continue; // redirect artifact (2>/dev/null, >/dev/null)
        if (isScriptArg(t)) continue;
        out.push(t);
      }
    }
  }

  return [...new Set(out)];
}
