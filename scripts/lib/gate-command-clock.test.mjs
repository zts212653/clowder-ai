import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGateCommandClock } from './gate-command-clock.mjs';
import { parseMacSleepEvidence, readMacSleepEvidence } from './gate-sleep-evidence.mjs';

const uuid = '1EE51960-686D-4C62-8260-0F89896CEE7E';
const powerRows = `1793988015\t840698000\tSleep\t${uuid}\n1793988943\t668020000\tDarkWake\t${uuid}\n`;
const available = (confirmedSleep) => ({ status: 'available', confirmedSleep });
const interval = (startedAt, endedAt) => ({ evidenceId: 'confirmed-sleep', startedAt, endedAt });

function clockFixture(read) {
  let raw = 0;
  let wall = 1_000_000;
  let calls = 0;
  const advance = (ms, wallMs = ms) => {
    raw += ms;
    wall += wallMs;
  };
  const clock = createGateCommandClock({
    now: () => raw,
    wallNow: () => wall,
    readSleepEvidence: (window) => {
      calls += 1;
      return read(window, advance);
    },
  });
  return { clock, advance, calls: () => calls };
}

test('the native power format pairs the actual Sleep and DarkWake with fractional timestamps', () => {
  const result = parseMacSleepEvidence(powerRows);
  assert.equal(result.status, 'available');
  assert.equal(result.confirmedSleep.length, 1);
  assert.equal(result.confirmedSleep[0].startedAt, 1793988015840.698);
  assert.equal(result.confirmedSleep[0].endedAt, 1793988943668.02);
});

test('a missing or mismatched wake cannot span awake work before a later sleep', () => {
  const other = '2EE51960-686D-4C62-8260-0F89896CEE7E';
  const result = parseMacSleepEvidence(
    `10\t0\tSleep\t${uuid}\n11\t0\tWake\t${other}\n12\t0\tSleep\t${uuid}\n13\t0\tSleep\t${other}\n14\t0\tDarkWake\t${other}\n`,
  );
  assert.deepEqual(
    result.confirmedSleep.map(({ startedAt, endedAt }) => [startedAt, endedAt]),
    [[13_000, 14_000]],
  );
});

test('malformed and out-of-order power events are unavailable rather than sleep proof', () => {
  for (const text of [`${powerRows}truncated\n`, `11\t0\tSleep\t${uuid}\n10\t0\tWake\t${uuid}\n`]) {
    assert.equal(parseMacSleepEvidence(text).status, 'unavailable');
  }
});

test('power reads select bounded date files and structured event types, without the full pmset history', () => {
  let command;
  const result = readMacSleepEvidence(
    { from: Date.parse('2026-11-06T23:59:59Z'), to: Date.parse('2026-11-07T00:01:00Z') },
    {
      platform: 'darwin',
      exists: () => true,
      execute: (file, args, options) => {
        command = { file, args, options };
        return powerRows;
      },
    },
  );
  assert.equal(result.status, 'available');
  assert.equal(command.file, '/usr/bin/syslog');
  assert.deepEqual(
    command.args.filter((arg) => arg.endsWith('.asl')),
    [
      '/var/log/powermanagement/2026.11.05.asl',
      '/var/log/powermanagement/2026.11.06.asl',
      '/var/log/powermanagement/2026.11.07.asl',
      '/var/log/powermanagement/2026.11.08.asl',
    ],
  );
  assert.ok(command.args.includes('sec'));
  assert.ok(command.args.includes('^(Sleep|DarkWake|Wake)$'));
  assert.ok(command.options.timeout > 0 && command.options.timeout <= 5_000);
  assert.equal(command.options.killSignal, 'SIGKILL');
});

test('missing, unreadable and unsupported power evidence never supplies a sleep interval', () => {
  const window = { from: 1000, to: 2000 };
  assert.equal(readMacSleepEvidence(window, { platform: 'darwin', exists: () => false }).status, 'unavailable');
  assert.equal(
    readMacSleepEvidence(window, { platform: 'linux', execute: () => assert.fail('no mac command') }).status,
    'unavailable',
  );
  assert.deepEqual(
    readMacSleepEvidence(window, {
      platform: 'darwin',
      exists: () => true,
      execute: () => {
        throw new Error('read timed out');
      },
    }),
    { status: 'unavailable', reason: 'power log read failed: read timed out' },
  );
});

test('an eastern local-date power file is selected before that date starts in UTC', () => {
  let selectedFiles;
  const result = readMacSleepEvidence(
    {
      from: Date.parse('2026-11-06T18:00:00Z'),
      to: Date.parse('2026-11-06T18:16:00Z'),
    },
    {
      platform: 'darwin',
      // In UTC+9 this window is already November 7; the native file uses that date.
      exists: (file) => file === '/var/log/powermanagement/2026.11.07.asl',
      execute: (_file, args) => {
        selectedFiles = args.filter((arg) => arg.endsWith('.asl'));
        return powerRows;
      },
    },
  );
  assert.equal(result.status, 'available');
  assert.deepEqual(selectedFiles, ['/var/log/powermanagement/2026.11.07.asl']);
  assert.equal(result.confirmedSleep.length, 1);
});

test('the clock subtracts only the union of completed, confirmed sleep inside the observed gap', () => {
  const f = clockFixture(() => available([interval(1_000_200, 1_002_200), interval(1_001_200, 1_002_500)]));
  f.advance(3_000);
  assert.equal(f.clock.now(), 700);
  assert.equal(f.clock.sleepDurationMs(), 2_300);
  f.advance(50);
  assert.equal(f.clock.now(), 750);
  assert.equal(f.calls(), 1);
  f.advance(3_000);
  assert.equal(f.clock.now(), 3_750);
  assert.equal(f.clock.sleepDurationMs(), 2_300, 'the same interval cannot be credited by the next delayed sample');
  assert.equal(f.calls(), 2);
});

test('empty, unavailable, throwing, or future-dated evidence leaves a delayed supervisor fully charged', () => {
  for (const read of [
    () => available([]),
    () => ({ status: 'unavailable' }),
    () => {
      throw new Error('reader failed');
    },
    () => available([interval(1_000_100, 1_010_000)]),
    () => available([interval(1_000_500, 1_002_000), interval(1_003_000, 1_010_000)]),
  ]) {
    const f = clockFixture(read);
    f.advance(3_000);
    assert.equal(f.clock.now(), 3_000);
    assert.equal(f.clock.sleepDurationMs(), 0);
  }
});

test('reader latency is charged once and does not itself trigger another power probe', () => {
  const f = clockFixture((_window, advance) => {
    advance(1_500);
    return available([interval(1_000_100, 1_002_500)]);
  });
  f.advance(2_600);
  assert.equal(f.clock.now(), 1_700);
  f.advance(50);
  assert.equal(f.clock.now(), 1_750);
  assert.equal(f.calls(), 1);
});

test('a wall clock jump cannot turn unrelated historical sleep into execution-budget credit', () => {
  const f = clockFixture(() => assert.fail('a discontinuous wall window must not be queried'));
  f.advance(3_000, 13_000);
  assert.equal(f.clock.now(), 3_000);
  assert.equal(f.clock.sleepDurationMs(), 0);
  assert.equal(f.calls(), 0, 'clock-jump evidence must not even reach the reader');
});
