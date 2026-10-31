import { describe, expect, it } from 'vitest';
import { videoProjectDocumentSchema } from '../types/video-project.js';
import { actor, origin, project } from './video-project.fixtures.js';

function rejects(value: unknown) {
  expect(videoProjectDocumentSchema.safeParse(value).success).toBe(false);
}

describe('video-project durable structure contract', () => {
  it('preserves raw user text, unknown renderer JSON and tail audio exactly', () => {
    expect(videoProjectDocumentSchema.parse(project())).toEqual(project());
  });

  it('rejects unsupported versions and unknown fields instead of stripping them', () => {
    rejects({ ...project(), schemaVersion: 2 });
    rejects({ ...project(), ownerRevision: 1 });
    const p = project();
    rejects({ ...p, timeline: { ...p.timeline, rawRendererHead: {} } });
    rejects({ ...p, origin: { ...origin, guessedAuthor: actor } });
  });

  it.each([
    Number.MAX_SAFE_INTEGER + 1,
    0,
    -1,
    0.5,
    Number.NaN,
  ])('rejects invalid positive ticks %s', (durationTicks) => {
    const p = project();
    rejects({ ...p, timeline: { ...p.timeline, durationTicks } });
  });

  it('rejects unreduced or invalid timebases', () => {
    const p = project();
    for (const timebase of [
      { numerator: 2, denominator: 60 },
      { numerator: 1, denominator: 0 },
    ]) {
      rejects({ ...p, timeline: { ...p.timeline, timebase } });
    }
  });

  it('rejects unsorted, overlapping, overflowing and out-of-project narrative segments', () => {
    const p = project();
    const shot = p.timeline.segments[0];
    for (const startTick of [50, -1, 250, Number.MAX_SAFE_INTEGER]) {
      rejects({
        ...p,
        timeline: { ...p.timeline, segments: [shot, { ...shot, id: 'shot-2', visuals: [], startTick }] },
      });
    }
    rejects({
      ...p,
      timeline: {
        ...p.timeline,
        segments: [
          { ...shot, startTick: 100 },
          { ...shot, id: 'shot-2', startTick: 0, visuals: [] },
        ],
      },
    });
  });

  it('allows narrative gaps, parallel layers and tail audio without moving starts', () => {
    const p = project();
    const shot = p.timeline.segments[0];
    const value = {
      ...p,
      timeline: {
        ...p.timeline,
        segments: [
          shot,
          {
            ...shot,
            id: 'shot-2',
            startTick: 150,
            visuals: [
              { id: 'visual-2', generated: { color: 'red' }, startTick: 0, endTick: 80 },
              { id: 'visual-3', generated: { color: 'blue' }, startTick: 40, endTick: 100 },
            ],
          },
        ],
      },
    };
    expect(videoProjectDocumentSchema.parse(value)).toEqual(value);
  });

  it('requires nonempty half-open visual ranges and exactly one frozen source', () => {
    const p = project();
    const shot = p.timeline.segments[0];
    const visual = shot.visuals[0];
    const cases = [
      { ...visual, startTick: 100 },
      { ...visual, endTick: 101 },
      { ...visual, startTick: -1 },
      { id: 'visual-1', startTick: 0, endTick: 10 },
      { ...visual, generated: { color: 'red' } },
    ];
    for (const v of cases) rejects({ ...p, timeline: { ...p.timeline, segments: [{ ...shot, visuals: [v] }] } });
  });

  it.each([
    '/etc/passwd',
    '../outside',
    'dir/../outside',
    'https://example.com/a',
    'C:\\secrets',
    'dir\\..\\outside',
    '//network/a',
    'dir//a',
    './a',
    'dir/./a',
    'a\u0000b',
  ])('rejects unsafe indexed locator %s', (path) => {
    const p = project();
    const asset = p.assets[0];
    const version = asset.versions[0];
    rejects({ ...p, assets: [{ ...asset, versions: [{ ...version, locator: { ...version.locator, path } }] }] });
  });

  it('rejects blank names while retaining explicit unknown imported provenance', () => {
    const p = project();
    rejects({ ...p, title: ' \n ' });
    rejects({ ...p, checkPages: [{ ...p.checkPages[0], name: '  ' }] });
    expect(videoProjectDocumentSchema.parse(p)).toEqual(p);
  });

  it('rejects non-JSON, cyclic, oversized and excessively nested renderer payloads', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let deep: unknown = 0;
    for (let i = 0; i < 40; i++) deep = { child: deep };
    const p = project();
    for (const payload of [
      undefined,
      { value: undefined },
      { value: () => 1 },
      { n: Number.NaN },
      new Date(),
      cyclic,
      deep,
      'x'.repeat(1_048_577),
    ]) {
      rejects({ ...p, timeline: { ...p.timeline, extensions: [{ namespace: 'future', schemaVersion: 1, payload }] } });
    }
  });

  it('preserves known asset orientation and rejects unsupported rotations', () => {
    const p = project();
    const asset = p.assets[0];
    const version = asset.versions[0];
    const value = { ...p, assets: [{ ...asset, versions: [{ ...version, rotation: 90 }] }] };
    expect(videoProjectDocumentSchema.parse(value)).toEqual(value);
    rejects({ ...p, assets: [{ ...asset, versions: [{ ...version, rotation: 45 }] }] });
  });

  it('rejects sparse arrays even if an extra property masks the missing array index', () => {
    const payload: unknown[] = new Array(1);
    Object.defineProperty(payload, 'side', { value: 'would be lost', enumerable: true });
    const p = project();
    rejects({ ...p, timeline: { ...p.timeline, extensions: [{ namespace: 'future', schemaVersion: 1, payload }] } });
  });

  it('rejects overflowing event ends while allowing a valid end beyond output duration', () => {
    const p = project();
    rejects({
      ...p,
      timeline: {
        ...p.timeline,
        events: [{ ...p.timeline.events[0], startTick: Number.MAX_SAFE_INTEGER, durationTicks: 1 }],
      },
    });
  });

  it('snapshots renderer JSON so caller mutation cannot bypass validation during an async commit', () => {
    const p = project();
    const payload = { gain: 0.6 };
    const parsed = videoProjectDocumentSchema.parse({
      ...p,
      timeline: { ...p.timeline, extensions: [{ namespace: 'renderer', schemaVersion: 1, payload }] },
    });
    payload.gain = 0.9;
    expect(parsed.timeline.extensions?.[0]?.payload).toEqual({ gain: 0.6 });
  });
});
