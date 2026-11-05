import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workVideoContextSchema } from '../../shared/src/types/work-video.js';

const context = () => ({
  format: 'video',
  extractorVersion: 'frozen-timeline',
  provenance: [{ ref: 'git:film@v2:timeline.json', digest: `sha256:${'a'.repeat(64)}` }],
  production: { createdAt: '2026-10-19T12:00:00.000Z', sourceRef: 'release/v2.mp4' },
  chapters: [
    { id: 'opening', title: '序章', streamId: 'main', startPts: 0, endPts: 10000, sourceId: 'film#chapter:opening' },
    { id: 'ending', title: '终章', streamId: 'main', startPts: 10000, endPts: 20000, sourceId: 'film#chapter:ending' },
  ],
  story: [
    {
      id: 'line',
      chapterId: 'opening',
      title: '旁白',
      text: '实际原文',
      streamId: 'main',
      startPts: 1000,
      endPts: 5000,
    },
  ],
  assets: [],
});
test('retains sourced chapter coordinates and original production date on the fixed version', () => {
  const input = context();
  assert.deepEqual(workVideoContextSchema.parse(input), input);
});
test('a line cannot claim an absent chapter or a chapter on another media clock', () => {
  const missing = context();
  missing.story[0].chapterId = 'absent';
  assert.equal(workVideoContextSchema.safeParse(missing).success, false);
  const wrongClock = context();
  wrongClock.chapters[0].streamId = 'other';
  assert.equal(workVideoContextSchema.safeParse(wrongClock).success, false);
});
test('rejects duplicate chapter identities, inverted bounds and lines outside their chapter', () => {
  const duplicate = context();
  duplicate.chapters[1].id = 'opening';
  assert.equal(workVideoContextSchema.safeParse(duplicate).success, false);
  const inverted = context();
  inverted.chapters[0].endPts = -1;
  assert.equal(workVideoContextSchema.safeParse(inverted).success, false);
  const outside = context();
  outside.story[0].endPts = 10001;
  assert.equal(workVideoContextSchema.safeParse(outside).success, false);
});
test('legacy context stays readable without inventing chapters or a production timestamp', () => {
  const { chapters, production, ...input } = context();
  const { chapterId, ...line } = input.story[0];
  const legacy = { ...input, story: [line] };
  assert.deepEqual(workVideoContextSchema.parse(legacy), legacy);
});
