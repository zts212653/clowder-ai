import { describe, expect, it } from 'vitest';
import { readMessageOutputLayout } from '../message-output-layout.js';

const identity = { provider: 'codex', runtimeSessionId: 'native', turnId: 'turn', nativeId: 'output' };
const layout = {
  v: 1,
  owner: { threadId: 'thread', catId: 'codex61-sol', turnInvocationId: 'child' },
  contentRevision: { length: 8, sha256: 'a'.repeat(64) },
  status: 'available',
  runs: [{ id: 'run', identity, channel: 'final', complete: true, start: 0, end: 8, gluePrefixLength: 0 }],
  order: [{ kind: 'run', runId: 'run' }],
};

describe('optional message layout wire validation', () => {
  it('round-trips references without a second body', () => {
    expect(readMessageOutputLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout);
  });
  for (const [name, patch] of [
    ['version', { v: 2 }],
    ['body copy', { content: 'duplicate' }],
    ['hash', { contentRevision: { length: 8, sha256: 'bad' } }],
    ['gap', { runs: [{ ...layout.runs[0], start: 1 }] }],
    ['overflow', { runs: [{ ...layout.runs[0], end: 9 }] }],
    ['unknown channel', { runs: [{ ...layout.runs[0], channel: 'unknown' }] }],
    ['incomplete', { runs: [{ ...layout.runs[0], complete: false }] }],
    ['no final', { runs: [{ ...layout.runs[0], channel: 'commentary' }] }],
    ['duplicate run', { runs: [layout.runs[0], layout.runs[0]] }],
    ['dangling run', { order: [{ kind: 'run', runId: 'missing' }] }],
    ['unreferenced run', { order: [] }],
    ['duplicate order ref', { order: [layout.order[0], layout.order[0]] }],
    ['empty tool instance', { order: [layout.order[0], { kind: 'tool', toolEventId: '', executionRef: 'child' }] }],
    [
      'over budget',
      { order: Array.from({ length: 513 }, (_, n) => ({ kind: 'tool', toolEventId: `t${n}`, executionRef: 'child' })) },
    ],
  ] as const) {
    it(`rejects ${name} instead of hiding text`, () => {
      expect(readMessageOutputLayout({ ...layout, ...patch })).toBeUndefined();
    });
  }
  it('preserves honest unavailable evidence but rejects content attached to it', () => {
    const { runs: _runs, order: _order, ...common } = layout;
    const value = { ...common, status: 'unavailable', reason: 'incomplete' };
    expect(readMessageOutputLayout(value)).toEqual(value);
    expect(readMessageOutputLayout({ ...value, content: 'do not duplicate' })).toBeUndefined();
  });
});

describe('terminal host tail wire ownership', () => {
  const hostTail = {
    kind: 'cat_signature',
    producer: 'codex_stream_finalizer',
    basis: 'runtime_canonical',
    start: 8,
    end: 16,
    gluePrefixLength: 2,
  };
  const signed = { ...layout, contentRevision: { ...layout.contentRevision, length: 16 }, hostTail };
  it('covers a terminal suffix separately from complete native final ranges', () => {
    expect(readMessageOutputLayout(JSON.parse(JSON.stringify(signed)))).toEqual(signed);
  });
  for (const [name, patch] of [
    ['unknown producer', { hostTail: { ...hostTail, producer: 'provider' } }],
    ['unknown kind', { hostTail: { ...hostTail, kind: 'text' } }],
    ['unknown basis', { hostTail: { ...hostTail, basis: 'guessed' } }],
    ['gap', { hostTail: { ...hostTail, start: 9 } }],
    ['overlap', { hostTail: { ...hostTail, start: 7 } }],
    ['nonterminal', { hostTail: { ...hostTail, end: 15 } }],
    ['incomplete native', { runs: [{ ...layout.runs[0], complete: false }] }],
    ['no native final', { runs: [{ ...layout.runs[0], channel: 'commentary' }] }],
    ['signature-only', { runs: [], order: [] }],
    ['duplicate ownership', { hostTail: [hostTail, hostTail] }],
    ['tail body copy', { hostTail: { ...hostTail, content: 'duplicate' } }],
  ] as const)
    it(`rejects ${name}`, () => {
      expect(readMessageOutputLayout({ ...signed, ...patch })).toBeUndefined();
    });
});

describe('successful-turn boundary wire evidence', () => {
  const boundary = {
    ...layout,
    basis: 'successful_turn_last_tool',
    runs: [
      { id: 'early', channel: 'commentary', start: 0, end: 3, gluePrefixLength: 0 },
      { id: 'answer', channel: 'final', start: 3, end: 8, gluePrefixLength: 2 },
    ],
    order: [
      { kind: 'run', runId: 'early' },
      { kind: 'tool', toolEventId: 'read', executionRef: 'child' },
      { kind: 'run', runId: 'answer' },
    ],
  };
  it('round-trips terminal ranges without inventing native identities', () => {
    expect(readMessageOutputLayout(JSON.parse(JSON.stringify(boundary)))).toEqual(boundary);
  });
  it('rejects a native identity on an inferred boundary and a final range before the last tool', () => {
    expect(
      readMessageOutputLayout({ ...boundary, runs: [{ ...boundary.runs[0], identity }, boundary.runs[1]] }),
    ).toBeUndefined();
    expect(
      readMessageOutputLayout({ ...boundary, runs: [{ ...boundary.runs[0], channel: 'final' }, boundary.runs[1]] }),
    ).toBeUndefined();
    expect(
      readMessageOutputLayout({
        ...boundary,
        order: [...boundary.order, { kind: 'tool', toolEventId: 'later', executionRef: 'child' }],
      }),
    ).toBeUndefined();
  });
});
