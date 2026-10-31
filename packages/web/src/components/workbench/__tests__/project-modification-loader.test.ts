import { beforeEach, expect, it, vi } from 'vitest';
import { modificationInputs } from '../video-project/modification-inputs';
import { loadProjectModification } from '../video-project/modification-loader';
import {
  modificationAnchor,
  modificationAt,
  modificationOpinion,
  modificationScreening,
  modificationSnapshot,
  twoArtworkModification,
} from './modification.fixture';

const { request, replies } = vi.hoisted(() => ({ request: vi.fn(), replies: new Map<string, unknown>() }));
vi.mock('@/utils/api-client', () => ({ apiFetch: request }));
beforeEach(() => {
  replies.clear();
  request
    .mockReset()
    .mockImplementation(async (path: string) =>
      replies.has(path) ? Response.json(replies.get(path)) : Response.json({ error: 'not_found' }, { status: 404 }),
    );
});
const path = (revision: number) => `/api/video-projects/project-1?ownerRevision=${revision}`;
function snapshots() {
  const before = modificationSnapshot(1),
    after = modificationSnapshot(2);
  replies.set(path(1), before);
  replies.set(path(2), after);
  return { before, after };
}
const signal = () => new AbortController().signal;
it.each([
  'missing',
  'wrong-digest',
  'absent',
  'unmapped',
  'verified',
])('keeps second-pair %s evidence independent of a verified first pair', async (candidate) => {
  const { before, after, firstOnly, unknown, annotation } = twoArtworkModification();
  for (const snapshot of [before, after, firstOnly]) replies.set(path(snapshot.ownerRevision), snapshot);
  const screenings = [modificationScreening(firstOnly, 'first-film')];
  if (candidate !== 'absent') screenings.push(modificationScreening(unknown, 'second-film'));
  if (candidate !== 'missing') replies.set(path(4), unknown);
  if (candidate === 'wrong-digest') screenings[1].input.blobDigest = `sha256:${'e'.repeat(64)}`;
  if (candidate === 'unmapped') {
    screenings[1].mapping.segments[0].projectEndTick = 1400;
    screenings[1].mapping.segments[0].mediaEndPts = 1400 * 512;
  }
  const data = await loadProjectModification('project-1', annotation, screenings, signal());
  expect(data.jumpUnavailable).toBe(false);
  expect(data.filmsByPair[0]).toMatchObject({ pairId: data.pairs[0].id, jump: { screeningId: 'first-film' } });
  expect(data.filmsByPair[1]).toMatchObject({
    pairId: data.pairs[1].id,
    unavailable: candidate === 'missing' || candidate === 'wrong-digest',
    jump: candidate === 'verified' ? { screeningId: 'second-film', pts: 1469 * 512 } : null,
  });
});
it('offers an explicitly original-film jump at the actual original artwork appearance when no changed film exists', async () => {
  const { before, after } = snapshots();
  const data = await loadProjectModification(
    'project-1',
    modificationOpinion(before, after),
    [modificationScreening(before, 'original-film')],
    signal(),
  );
  expect(data.jump).toBeNull();
  expect(data.originalJumps).toEqual([
    { pairId: data.pairs[0].id, screeningId: 'original-film', pts: 1429 * 512, seconds: 1429 / 30 },
  ]);
});
it('does not offer original-film navigation for an unverified digest or unmapped appearance', async () => {
  const { before, after } = snapshots();
  const wrong = modificationScreening(before, 'wrong-digest');
  wrong.input.blobDigest = `sha256:${'e'.repeat(64)}`;
  const unmapped = modificationScreening(before, 'unmapped');
  unmapped.mapping.segments[0].projectEndTick = 1400;
  const data = await loadProjectModification(
    'project-1',
    modificationOpinion(before, after),
    [wrong, unmapped],
    signal(),
  );
  expect(data.originalJumps).toEqual([]);
  expect(data.jump).toBeNull();
});
it('reads the actual original/result inputs and maps C08c appearance at 1429, never shot start 1359', async () => {
  const { before, after } = snapshots();
  const data = await loadProjectModification(
    'project-1',
    modificationOpinion(before, after),
    [modificationScreening(after)],
    signal(),
  );
  expect(request.mock.calls.map(([value]) => value)).toEqual([path(2), path(1)]);
  expect(data.pairs[0]).toMatchObject({
    before: { ownerRevision: 1, version: { id: 'png-old' } },
    after: { ownerRevision: 2, version: { id: 'png-new' } },
  });
  expect(data.jump).toEqual({ screeningId: 'rendered-change', pts: 1429 * 512 });
});
it.each(['origin', 'result'])('rejects a mismatched %s digest before offering images or a jump', async (which) => {
  const { before, after } = snapshots();
  const opinion = modificationOpinion(before, after);
  if (which === 'origin') opinion.anchor = { ...modificationAnchor(before), baseRevision: `sha256:${'e'.repeat(64)}` };
  else if (opinion.projectHistory?.[0].result && 'blobDigest' in opinion.projectHistory[0].result)
    opinion.projectHistory[0].result.blobDigest = `sha256:${'e'.repeat(64)}`;
  await expect(loadProjectModification('project-1', opinion, [modificationScreening(after)], signal())).rejects.toThrow(
    '摘要不匹配',
  );
});
it('retains each prior-located base and ignores a later location rewrite', async () => {
  const { before, after } = snapshots();
  const secondBase = modificationSnapshot(3, false),
    result = modificationSnapshot(4);
  replies.set(path(3), secondBase);
  replies.set(path(4), result);
  const opinion = modificationOpinion(before, result);
  opinion.projectHistory?.unshift({
    kind: 'located',
    actor: { kind: 'cat', actorId: 'sol' },
    at: modificationAt,
    operationId: 'locate',
    targets: [modificationAnchor(before), modificationAnchor(secondBase)],
  });
  opinion.projectHistory?.push({
    kind: 'located',
    actor: { kind: 'cat', actorId: 'sol' },
    at: modificationAt,
    operationId: 'later',
    targets: [modificationAnchor(after, { kind: 'segment', segmentId: 'opening' })],
  });
  const data = await loadProjectModification('project-1', opinion, [], signal());
  expect(request.mock.calls.map(([value]) => value)).toEqual([path(4), path(1), path(3)]);
  expect(data.pairs.map((pair) => pair.before.ownerRevision)).toEqual([1, 3]);
});
it('never compares an unchanged localized target using an unrelated shot change', () => {
  const { before, after } = snapshots();
  const changes = modificationInputs(
    [{ anchor: modificationAnchor(before, { kind: 'segment', segmentId: 'opening' }), snapshot: before }],
    after,
  );
  expect(changes).toEqual({ pairs: [], uses: [] });
});
it.each([
  'id',
  'mime',
  'duration',
  'zero-rotation',
])('does not show identical rendered PNGs after only %s metadata changed', (change) => {
  const { before, after } = snapshots();
  const versions = after.document.assets[0].versions;
  versions[1] = { ...versions[0], id: 'png-new' };
  if (change === 'mime') versions[1].mediaType = 'Image/PNG';
  if (change === 'duration') versions[1].durationTicks = 999;
  if (change === 'zero-rotation') versions[1].rotation = 0;
  expect(modificationInputs([{ anchor: modificationAnchor(before), snapshot: before }], after)).toEqual({
    pairs: [],
    uses: [],
  });
});
it('tracks true orientation changes and stable visual IDs after a new visual is inserted', () => {
  const { before, after } = snapshots();
  after.document.assets[0].versions[1].sha256 = before.document.assets[0].versions[0].sha256;
  after.document.assets[0].versions[1].rotation = 90;
  after.document.timeline.segments[1].visuals.unshift({
    id: 'earlier',
    generated: { color: 'blue' },
    startTick: 0,
    endTick: 70,
  });
  const data = modificationInputs([{ anchor: modificationAnchor(before), snapshot: before }], after, 'png-new');
  expect(data.pairs).toHaveLength(1);
  expect(data.pairs[0].after.version.rotation).toBe(90);
  expect(data.uses.map((use) => use.id)).toEqual(['C08c']);
});
it('does not substitute an old or later unmodified film for the exact changed stable material', async () => {
  const { before, after } = snapshots();
  const later = modificationSnapshot(3, false);
  replies.set(path(3), later);
  const data = await loadProjectModification(
    'project-1',
    modificationOpinion(before, after),
    [modificationScreening(before, 'old'), modificationScreening(later, 'later-wrong')],
    signal(),
  );
  expect(data.jump).toBeNull();
  expect(data.jumpUnavailable).toBe(false);
});
it('distinguishes unrendered/unmapped material from inaccessible or wrong-digest evidence', async () => {
  const { before, after } = snapshots();
  const screening = modificationScreening(after);
  screening.mapping.segments[0].projectEndTick = 1400;
  screening.mapping.segments[0].mediaEndPts = 1400 * 512;
  let data = await loadProjectModification('project-1', modificationOpinion(before, after), [screening], signal());
  expect(data).toMatchObject({ jump: null, jumpUnavailable: false });
  screening.input.blobDigest = `sha256:${'e'.repeat(64)}`;
  data = await loadProjectModification('project-1', modificationOpinion(before, after), [screening], signal());
  expect(data).toMatchObject({ jump: null, jumpUnavailable: true });
  screening.input.ownerRevision = 99;
  data = await loadProjectModification('project-1', modificationOpinion(before, after), [screening], signal());
  expect(data).toMatchObject({ jump: null, jumpUnavailable: true });
});
it('shows not-changed evidence without inventing a new revision or loading images', async () => {
  const { before, after } = snapshots();
  const data = await loadProjectModification(
    'project-1',
    modificationOpinion(before, after, { kind: 'not-changed', reason: '保持原稿，说明依据。' }),
    [],
    signal(),
  );
  expect(data.notChanged).toBe('保持原稿，说明依据。');
  expect(data.pairs).toEqual([]);
  expect(request).not.toHaveBeenCalled();
});
it('shows actual timing-only receipt evidence without drawing the same PNG twice', async () => {
  const { before, after } = snapshots();
  after.document.timeline.segments[1].visuals[0].assetVersionRef = 'png-old';
  after.document.timeline.segments[1].visuals[0].startTick = 80;
  const data = await loadProjectModification(
    'project-1',
    modificationOpinion(before, after),
    [modificationScreening(after)],
    signal(),
  );
  expect(data.pairs).toEqual([]);
  expect(data.ownerRevision).toBe(2);
  expect(data.jump).toEqual({ screeningId: 'rendered-change', pts: 1439 * 512 });
});

it.each(['receipt', 'asset'])('tracks real audio replacement across the full moment range for %s', async (kind) => {
  const { before, after } = snapshots();
  for (const snapshot of [before, after]) {
    snapshot.document.timeline.segments[1].visuals[0].assetVersionRef = 'png-old';
    snapshot.document.assets[0].versions.push(
      {
        ...snapshot.document.assets[0].versions[0],
        id: 'audio-old',
        mediaType: 'audio/wav',
      },
      {
        ...snapshot.document.assets[0].versions[1],
        id: 'audio-new',
        mediaType: 'audio/wav',
      },
    );
    snapshot.document.timeline.events = [
      {
        id: 'sound',
        kind: 'audio',
        startTick: 1450,
        durationTicks: 10,
        assetVersionRef: snapshot === before ? 'audio-old' : 'audio-new',
      },
    ];
  }
  replies.set(path(1), before);
  replies.set(path(2), after);
  const opinion = modificationOpinion(
    before,
    after,
    kind === 'asset' ? { assetVersionRef: 'audio-new', ownerRevision: 2 } : undefined,
  );
  opinion.anchor = modificationAnchor(before, {
    kind: 'moment',
    tick: 1429,
    endTick: 1480,
    timebase: { numerator: 1, denominator: 30 },
    visualUseId: 'C08c',
  });
  let data = await loadProjectModification('project-1', opinion, [modificationScreening(after)], signal());
  expect(data.pairs).toEqual([]);
  expect(data.jump).toEqual({ screeningId: 'rendered-change', pts: 1450 * 512 });
  opinion.anchor = modificationAnchor(before, {
    kind: 'moment',
    tick: 1429,
    endTick: 1480,
    timebase: { numerator: 1, denominator: 30 },
    region: {
      coordinateSpace: 'canvas-pixels',
      width: 1920,
      height: 1080,
      rotation: 0,
      bbox: { x: 0, y: 0, width: 10, height: 10 },
    },
  });
  data = await loadProjectModification('project-1', opinion, [modificationScreening(after)], signal());
  expect(data.jump).toBeNull();
});
