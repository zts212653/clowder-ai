import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync as removeFixture } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';

const { segmentLocations } = await import('../../../scripts/native-effect-segment-locations.mjs');
const { splitShellExecutionSegmentsWithSeparators } = await import(
  '../../../scripts/native-effect-shell-classifier.mjs'
);

// Differential check of the segment-location model against real bash (codex-astra review of
// #4817: check short-circuit, nesting and binding restore as a whole, not case by case).
// Only harmless atoms run: `cd` into fixture directories, `true`, `false`, assignments and
// `printf` of the working directory. Each `cd` may succeed or fail in the model, so bash runs
// every variant where any subset of the `cd`s is replaced by `false`; the union of what each
// marker prints across variants is the exact set the model must return for that segment.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'f306-bash-oracle-')));
after(() => removeFixture(root, { recursive: true, force: true }));
const dirs = { S: join(root, 'start'), A: join(root, 'a'), B: join(root, 'b') };
for (const directory of Object.values(dirs)) mkdirSync(directory, { recursive: true });

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/** A command from the exactly-modelled grammar: lists, && || ;, ( ), { ; }, !, assignments. */
function generate(rand, depth = 0, extra = []) {
  const pick = (items) => items[Math.floor(rand() * items.length)];
  const atom = () =>
    pick([
      () => `cd ${pick([dirs.A, dirs.B])}`,
      () => 'cd "$X"',
      () => `X=${pick([dirs.A, dirs.B])}`,
      () => 'true',
      () => 'false',
      () => 'MARK',
      () => 'MARK',
      () => (depth < 2 ? `( ${generate(rand, depth + 1, extra)} )` : 'MARK'),
      () => (depth < 2 ? `{ ${generate(rand, depth + 1, extra)}; }` : 'true'),
      () => `! ${pick(['true', 'false', `cd ${dirs.A}`])}`,
      ...extra,
    ])();
  const length = 2 + Math.floor(rand() * 4);
  let text = atom();
  for (let i = 1; i < length; i += 1) text += ` ${pick(['&&', '||', ';'])} ${atom()}`;
  return text;
}

const MARKER = /printf '@\d+:%s\\n' "\$\(pwd -P\)"/g;

function withMarkers(command) {
  let index = 0;
  return command.replace(/MARK/g, () => `printf '@${index++}:%s\\n' "$(pwd -P)"`);
}

function bashSets(command) {
  const cds = [...command.matchAll(/cd (?:"\$X"|[^\s;)}]+)/g)].map((match) => match.index);
  const seen = new Map();
  for (let mask = 0; mask < 2 ** cds.length; mask += 1) {
    let variant = command;
    for (let i = cds.length - 1; i >= 0; i -= 1) {
      if (!(mask & (1 << i))) continue;
      const end = variant.slice(cds[i]).match(/^cd (?:"\$X"|[^\s;)}]+)/)[0].length;
      variant = `${variant.slice(0, cds[i])}false${' '.repeat(end - 5)}${variant.slice(cds[i] + end)}`;
    }
    const run = spawnSync('bash', ['-c', variant], {
      cwd: dirs.S,
      env: { PATH: process.env.PATH, X: dirs.S },
      encoding: 'utf8',
    });
    for (const line of run.stdout.split('\n')) {
      const match = line.match(/^@(\d+):(.*)$/);
      if (match) (seen.get(match[1]) ?? seen.set(match[1], new Set()).get(match[1])).add(match[2]);
    }
  }
  return seen;
}

describe('segment locations agree with bash on the exactly-modelled grammar', () => {
  test('every reachable marker gets exactly the directories bash reaches', () => {
    // Widen locally with F306_ORACLE_SEED / F306_ORACLE_COUNT; the default keeps the suite fast.
    const rand = random(Number(process.env.F306_ORACLE_SEED ?? 20260927));
    const failures = [];
    for (let n = 0; n < Number(process.env.F306_ORACLE_COUNT ?? 150); n += 1) {
      const command = withMarkers(generate(rand));
      const segments = splitShellExecutionSegmentsWithSeparators(command);
      // The markers' printf always succeeds here; the model is shown `true` in their place,
      // because in general printf can fail and the model must not assume otherwise.
      const modelView = splitShellExecutionSegmentsWithSeparators(command.replace(MARKER, 'true'));
      assert.equal(modelView.length, segments.length, command);
      const predicted = segmentLocations(modelView, dirs.S, { X: dirs.S });
      for (const [marker, actual] of bashSets(command)) {
        const index = segments.findIndex((segment) => segment.text.includes(`'@${marker}:`));
        const model = new Set(predicted[index]);
        const same = model.size === actual.size && [...actual].every((directory) => model.has(directory));
        if (!same) failures.push(`${command}\n  @${marker}: bash=${[...actual]} model=${[...model]}`);
      }
    }
    assert.deepEqual(failures.slice(0, 5), [], `${failures.length} mismatches`);
  });

  // Commands whose status the model cannot know (a printf that succeeds, one that fails):
  // the model forks them, so it may name more directories than bash reaches but never fewer.
  test('never misses a directory when a command of unknown status fails or succeeds', () => {
    const rand = random(Number(process.env.F306_ORACLE_SEED ?? 20260928));
    const uncertain = [() => 'printf ok >/dev/null', () => "printf '%d' nope >/dev/null"];
    const weighted = [...uncertain, ...uncertain, ...uncertain];
    const failures = [];
    for (let n = 0; n < Number(process.env.F306_ORACLE_COUNT ?? 300); n += 1) {
      const command = withMarkers(generate(rand, 0, weighted));
      const segments = splitShellExecutionSegmentsWithSeparators(command);
      const predicted = segmentLocations(
        splitShellExecutionSegmentsWithSeparators(command.replace(MARKER, 'true')),
        dirs.S,
        { X: dirs.S },
      );
      for (const [marker, actual] of bashSets(command)) {
        const index = segments.findIndex((segment) => segment.text.includes(`'@${marker}:`));
        const model = new Set(predicted[index]);
        const missing = [...actual].filter((directory) => !model.has(directory));
        if (missing.length > 0) failures.push(`${command}\n  @${marker}: missing ${missing}`);
      }
    }
    assert.deepEqual(failures.slice(0, 5), [], `${failures.length} misses`);
  });
});
