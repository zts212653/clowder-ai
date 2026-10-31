import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * Every hold-ball card states whether its hold can still be canceled.
 *
 * The web card used to re-derive this from `source.meta.phase`, and that copy
 * was wrong: four producers announce a terminal under `phase:'status'` — launch
 * cancellation, spawn/runner loss, missed wake window, wake-admission failure —
 * so a finished hold kept live cancel controls whenever the status probe was
 * unavailable. The fix moved the fact to the producer, which only holds as long
 * as every producer actually states it.
 *
 * These read the real producer sources rather than a hand-built shape, so a new
 * hold-ball card that forgets the fact fails here instead of silently putting a
 * cancel button back on a hold that already ended.
 */

const API_SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

/**
 * @typedef {object} ProducerExpectation
 * @property {string} file    Source file, relative to packages/api/src.
 * @property {string} path    Which card this producer emits.
 * @property {boolean} cancelable  What that card must state.
 * @property {number} count  How many such statements the file must contain.
 */

/** @type {readonly ProducerExpectation[]} */
const EXPECTED_PRODUCERS = [
  { file: 'routes/callback-hold-ball-routes.ts', path: 'waiting card', cancelable: true, count: 1 },
  { file: 'routes/hold-ball-terminal-visibility.ts', path: 'terminal visibility', cancelable: false, count: 1 },
  {
    file: 'domains/ball-custody/ManagedCommandWakeRecoveryEngine.ts',
    path: 'spawn/runner loss',
    cancelable: false,
    count: 1,
  },
  {
    file: 'domains/ball-custody/ManagedCommandWakeRecoverySweep.ts',
    path: 'startup sweep admission fact',
    cancelable: false,
    count: 1,
  },
  {
    file: 'domains/ball-custody/RetiredManagedCommandTerminalRecovery.ts',
    path: 'terminal receipt',
    cancelable: false,
    count: 1,
  },
  {
    file: 'domains/ball-custody/managed-command-wake-message-fence.ts',
    path: 'wake receipt',
    cancelable: false,
    count: 1,
  },
  { file: 'infrastructure/scheduler/TaskRunnerV2.ts', path: 'missed wake window', cancelable: false, count: 1 },
  {
    file: 'infrastructure/scheduler/templates/reminder.ts',
    path: 'wake receipt + wake-admission failure',
    cancelable: false,
    count: 2,
  },
];

/** `hold-ball-source.ts` only declares the shared label/icon; it emits no card. */
const NON_EMITTING = new Set(['routes/hold-ball-source.ts']);

function walkTypeScript(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkTypeScript(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

/** Source files that build a hold-ball connector card with an inline meta block. */
function holdBallCardEmitters() {
  return walkTypeScript(API_SRC)
    .filter((full) => {
      const text = readFileSync(full, 'utf8');
      return /connector: 'hold-ball'|\.\.\.HOLD_BALL_SOURCE/.test(text) && /meta: \{/.test(text);
    })
    .map((full) => relative(API_SRC, full).split(/[\\/]/).join('/'))
    .filter((rel) => !NON_EMITTING.has(rel))
    .sort();
}

function countStatements(file, cancelable) {
  const text = readFileSync(join(API_SRC, file), 'utf8');
  return (text.match(new RegExp(`cancelable: ${cancelable}\\b`, 'g')) ?? []).length;
}

test('no hold-ball card emitter is unknown to this contract', () => {
  const known = new Set(EXPECTED_PRODUCERS.map((producer) => producer.file));
  const unregistered = holdBallCardEmitters().filter((rel) => !known.has(rel));
  assert.deepEqual(
    unregistered,
    [],
    `new hold-ball card emitter(s) must state cancelable on the card and be registered in this contract: ${unregistered.join(', ')}`,
  );
});

for (const producer of EXPECTED_PRODUCERS) {
  test(`${producer.file} states cancelable for its ${producer.path}`, () => {
    assert.equal(
      countStatements(producer.file, producer.cancelable),
      producer.count,
      `${producer.path} must state cancelable: ${producer.cancelable} exactly ${producer.count}x`,
    );
  });
}

test('the four exceptional terminals stay stated as terminal despite their "status" phase', () => {
  const exceptional = [
    ['routes/callback-hold-ball-routes.ts', 'launch cancellation'],
    ['domains/ball-custody/ManagedCommandWakeRecoveryEngine.ts', 'spawn/runner loss'],
    ['infrastructure/scheduler/TaskRunnerV2.ts', 'missed wake window'],
    ['infrastructure/scheduler/templates/reminder.ts', 'wake-admission failure'],
  ];
  for (const [file, label] of exceptional) {
    const text = readFileSync(join(API_SRC, file), 'utf8');
    assert.match(text, /phase: 'status'/, `${label} should still write phase:'status'`);
    assert.match(text, /cancelable: false/, `${label} must state cancelable: false`);
  }
});

test('exactly one producer may state a still-cancelable card', () => {
  const cancelableTrue = holdBallCardEmitters().filter((rel) => countStatements(rel, true) > 0);
  assert.deepEqual(cancelableTrue, ['routes/callback-hold-ball-routes.ts']);
});
