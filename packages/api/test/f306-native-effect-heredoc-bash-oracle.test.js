import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync as removeFixture, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const { hereDocumentView } = await import('../../../scripts/native-effect-heredoc.mjs');

// Differential check of the here-document lexer against real bash (slice 2, 2026-09-27).
// The one unsafe mistake is to drop text that bash executes: a body the lexer invents, a
// terminator it misreads, a comment or quote it takes for an operator. So bash runs random
// scripts whose every command prints a unique marker (to stdout, or to stderr from a
// substitution inside a body), and every marker bash printed must still be in the text the
// guard judges and in the text the self-host layer reads. Bodies mix in the lines that
// break naive readers: near-terminators, apostrophes, `)`, `#`, `$( )`, backticks.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'f306-heredoc-oracle-')));
after(() => removeFixture(root, { recursive: true, force: true }));
// One line of input for sed scripts read from stdin (codex-astra review of #4840): the script
// `s/x/@@S&N@@/p` prints `@@SxN@@` only if sed ran the body as its program.
const INPUT = join(root, 'in.txt');
writeFileSync(INPUT, 'x\n');

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// Words that serve as delimiters. A misread `<<` hides commands only if a line equal to its
// word follows, so the same words also appear as bare top-level lines (a harmless "command
// not found") and inside operators that are not here-documents.
const WORDS = ['D', 'EOF', 'END_1', '2'];

function generator(rand) {
  let marker = 0;
  const pick = (items) => items[Math.floor(rand() * items.length)];
  // The text differs from what it prints: `cat <<D` echoing a body is not running it.
  const mark = () => `echo @@M''${marker++}@@`;
  const word = () => pick(WORDS.slice(0, 3));
  const bodyLine = (delimiter) =>
    pick([
      () => mark(),
      () => `${delimiter} `,
      () => ` ${delimiter}`,
      () => `\t${delimiter}`,
      () => `${delimiter}x`,
      () => "don't",
      () => '"open',
      () => ')',
      () => `# note <<${word()}`,
      // bash 3.2 comments: at a line start or after a space they hide brackets, not quotes.
      () => pick(['a #)', 'a#)', '(#)', 'a #(', '#(x', "a #'q' )", 'a #"q', "## What's (new)"]),
      () => `cat <<${word()}`,
      () => `$(echo @@M''${marker++}@@ >&2)`,
      () => `\`echo @@M''${marker++}@@ >&2\``,
      () => pick(WORDS),
    ])();
  const body = (delimiter) => Array.from({ length: Math.floor(rand() * 4) }, () => bodyLine(delimiter));
  const decoy = (fake, fixed) => {
    const w = fixed ?? word();
    return [fake(w), mark(), w, mark()];
  };
  const heredoc = (owner, trailing = '') => {
    const delimiter = word();
    const [open, strip] = pick([
      [`'${delimiter}'`, false],
      [`"${delimiter}"`, false],
      [`\\${delimiter}`, false],
      [delimiter, false],
      [`-${delimiter}`, true],
      [`-'${delimiter}'`, true],
      [` '${delimiter}'`, false],
    ]);
    const terminator = rand() < 0.1 ? [] : [`${strip && rand() < 0.5 ? '\t' : ''}${delimiter}`];
    return [`${owner} <<${open}${trailing}`, ...body(delimiter), ...terminator];
  };
  const line = () =>
    pick([
      () => [mark()],
      () => [mark()],
      () => heredoc(pick(['cat >/dev/null', 'tee /dev/null >/dev/null', 'grep -c zzz >/dev/null', 'wc -l >/dev/null'])),
      () => heredoc('cat >/dev/null', `; ${mark()}`),
      () => heredoc(pick(['bash', 'sh'])),
      () => heredoc('while read l; do :; done'),
      // A reader whose option makes stdin its script: the body is a program, not data.
      () => [
        `sed -n ${pick(['-f -', '-f-', '-nf-', '-f/dev/stdin', '-f /dev/stdin'])} ${INPUT} <<'S'`,
        `s/x/@@S&${marker++}@@/p`,
        'S',
        mark(),
      ],
      // `<<-` strips leading tabs from the terminator; `<<` does not.
      () => decoy((w) => `cat >/dev/null <<-${w}\n\t${w}`),
      () => decoy((w) => `cat >/dev/null <<${w}\n\t${w}\n${w}`),
      () => [pick(WORDS)],
      // Not here-documents, owned by a command that would drop a body: if the lexer took the
      // `<<` for an operator, the marker before the matching word would vanish.
      () => decoy((w) => `cat >/dev/null # c <<${w} ${mark()}`),
      () => decoy((w) => `echo "q <<${w} x" >/dev/null`),
      () => decoy((w) => `echo 'q <<${w} x' >/dev/null`),
      () => decoy(() => 'echo $((1<<2)) >/dev/null', '2'),
      () => decoy((w) => `cat <<<'x <<${w} x' >/dev/null`),
      () => [`echo "$(cat <<'D9'`, ...body('D9'), 'D9', `)" >/dev/null`, mark()],
      // bash 3.2 closes the substitution at a stray `)`, and the rest of the body runs.
      () => [`echo "$(cat <<'D9'`, pick([')', 'a)', '(x))']), bodyLine('D9'), bodyLine('D9'), 'D9', `)" >/dev/null`],
      // Two messages: bash 3.2 closes the first one's open quote inside the second, and then
      // reads the second body as code.
      () => [
        `echo "$(cat <<'D9'`,
        "don't",
        'D9',
        `)" >/dev/null`,
        `echo "$(cat <<'D8'`,
        "it's",
        pick([')', 'a)']),
        bodyLine('D8'),
        'D8',
        `)" >/dev/null`,
        mark(),
      ],
      // `#` inside a word is not a comment to bash 3.2: its `)` still closes the substitution.
      () => [
        `echo "$(cat <<'D9'`,
        pick(['a#)', '(#))', 'x;#)', 'a #)']),
        `$(echo @@M''${marker++}@@ >&2)`,
        'D9',
        `)" >/dev/null`,
      ],
      // An unclosed `(` takes the message's own `)` in bash 3.2, which then reads on.
      () => [
        `echo "$(cat <<'D9'`,
        pick(['(x', 'a (b']),
        'D9',
        `)" >/dev/null`,
        `echo "$(cat <<'D8'`,
        pick([')', 'a)', '))']),
        bodyLine('D8'),
        bodyLine('D8'),
        'D8',
        `)" >/dev/null`,
        mark(),
      ],
      // A quote left open before a stray `)` hides it from bash 3.2's scan -- or must not.
      () => [
        `echo "$(cat <<'D9'`,
        pick(["don't", '"open', 'a`b']),
        pick([')', 'a)']),
        bodyLine('D9'),
        'D9',
        `)" >/dev/null`,
        mark(),
      ],
      () => [`x=$(cat <<'D8'`, ...body('D8'), 'D8', ')', mark()],
      () => [`( cat >/dev/null <<'D7'`, ...body('D7'), 'D7', `${mark()} )`],
      () => ['cat >/dev/null \\', `<<'D6'`, ...body('D6'), 'D6', mark()],
      () => [`cat >/dev/null <<'A'; cat >/dev/null <<'B'`, ...body('A'), 'A', ...body('B'), 'B', mark()],
    ])();
  return () =>
    Array.from({ length: 2 + Math.floor(rand() * 4) }, line)
      .flat()
      .join('\n');
}

// Cats' commands run under zsh or bash, and macOS /bin/bash is 3.2, which scans `$( … )`
// for its closing bracket instead of parsing it: a marker either shell runs must survive.
const SHELLS = ['/bin/bash', '/bin/zsh'].filter((shell) => existsSync(shell));

function executedMarkers(script) {
  return SHELLS.flatMap((shell) => {
    const result = spawnSync(shell, ['-c', script], { cwd: root, encoding: 'utf8', timeout: 10_000, env: {} });
    const output = `${result.stdout}\n${result.stderr}`;
    return [
      ...[...output.matchAll(/@@M(\d+)@@/g)].map((match) => `@@M''${match[1]}@@`),
      ...[...output.matchAll(/@@Sx(\d+)@@/g)].map((match) => `@@S&${match[1]}@@`),
    ];
  });
}

describe('F306 slice 2: here-document lexer against real bash', () => {
  test('never drops a command that bash runs', () => {
    const seed = Number(process.env.F306_ORACLE_SEED ?? 20260927);
    const count = Number(process.env.F306_ORACLE_COUNT ?? 300);
    const rand = random(seed);
    const script = generator(rand);
    let changed = 0;
    for (let sample = 0; sample < count; sample += 1) {
      const text = script();
      const view = hereDocumentView(text);
      if (view.judged !== text) changed += 1;
      for (const marker of executedMarkers(text)) {
        assert.ok(view.judged.includes(marker), `seed ${seed} sample ${sample}: judged text lost ${marker}\n${text}`);
        assert.ok(view.host.includes(marker), `seed ${seed} sample ${sample}: host text lost ${marker}\n${text}`);
      }
    }
    // The oracle must exercise the lexer, not only its fallback (decoys that the lexer is
    // unsure about leave a whole sample unchanged, by design).
    assert.ok(changed > count / 5, `only ${changed}/${count} samples had a body removed`);
  });
});
