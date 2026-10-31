import { describe, expect, it } from 'vitest';
import { videoProjectDocumentSchema } from '../types/video-project.js';
import { actor, digest, origin, project } from './video-project.fixtures.js';

function rejects(value: unknown) {
  expect(videoProjectDocumentSchema.safeParse(value).success).toBe(false);
}

describe('video-project frozen references and history', () => {
  it('rejects unresolved frozen asset, scene, segment and decision target references', () => {
    const p = project();
    const shot = p.timeline.segments[0];
    rejects({ ...p, timeline: { ...p.timeline, segments: [{ ...shot, sceneId: 'missing' }] } });
    rejects({
      ...p,
      timeline: {
        ...p.timeline,
        segments: [{ ...shot, visuals: [{ ...shot.visuals[0], assetVersionRef: 'latest' }] }],
      },
    });
    rejects({ ...p, timeline: { ...p.timeline, events: [{ ...p.timeline.events[0], segmentId: 'missing' }] } });
    rejects({ ...p, checkPages: [{ ...p.checkPages[0], references: ['missing'] }] });
    rejects({
      ...p,
      decisions: [{ ...p.decisions[0], targets: { sceneIds: [], segmentIds: [], assetIds: ['missing'] } }],
    });
  });

  it('rejects duplicate entity IDs, globally duplicate version IDs and repeated refs', () => {
    const p = project();
    rejects({ ...p, assets: [p.assets[0], { ...p.assets[0], id: 'another' }] });
    rejects({ ...p, timeline: { ...p.timeline, scenes: [p.timeline.scenes[0], p.timeline.scenes[0]] } });
    rejects({ ...p, checkPages: [{ ...p.checkPages[0], references: ['image-v1', 'image-v1'] }] });
    rejects({
      ...p,
      timeline: {
        ...p.timeline,
        segments: [p.timeline.segments[0], { ...p.timeline.segments[0], id: 'another', startTick: 100 }],
      },
    });
  });

  it('rejects result references outside their page scope and cyclic same-scene coverage', () => {
    const p = project();
    const page = p.checkPages[0];
    const result = p.checkResults[0];
    rejects({ ...p, checkPages: [{ ...page, scope: { kind: 'selectedScenes', sceneIds: [] } }] });
    rejects({ ...p, checkResults: [{ ...result, sceneId: 'missing' }] });
    rejects({ ...p, checkResults: [{ ...result, assetVersionRefs: ['missing'] }] });
    const covered = {
      id: 'cover',
      kind: 'coveredBy',
      pageId: 'face',
      sceneId: 'scene-1',
      inputOwnerRevision: 1,
      definitionDigest: digest,
      coveredByPageId: 'other',
      reason: '同一张检查',
      origin,
    };
    rejects({ ...p, checkResults: [covered] });
    rejects({
      ...p,
      checkPages: [page, { ...page, id: 'other' }],
      checkResults: [covered, { ...covered, id: 'cover-2', pageId: 'other', coveredByPageId: 'face' }],
    });
  });

  it('accepts explicit same-scene coverage and retained results from old definitions', () => {
    const p = project();
    const value = {
      ...p,
      checkPages: [p.checkPages[0], { ...p.checkPages[0], id: 'photo' }],
      checkResults: [
        ...p.checkResults,
        {
          id: 'cover',
          kind: 'coveredBy',
          pageId: 'photo',
          sceneId: 'scene-1',
          inputOwnerRevision: 2,
          definitionDigest: `sha256:${'b'.repeat(64)}`,
          coveredByPageId: 'face',
          reason: '由脸部页覆盖',
          origin,
        },
      ],
    };
    expect(videoProjectDocumentSchema.parse(value)).toEqual(value);
  });

  it('validates decision event shape without granting authority from actor IDs', () => {
    const p = project();
    const d = p.decisions[0];
    rejects({
      ...p,
      decisions: [
        {
          ...d,
          state: 'decided',
          history: [...d.history, { kind: 'decided', actor, at: origin.at, operationId: 'decide-1' }],
        },
      ],
    });
    const catEvent = {
      ...p,
      decisions: [
        {
          ...d,
          state: 'decided',
          history: [
            ...d.history,
            {
              kind: 'decided',
              actor: { kind: 'cat', actorId: 'named-decider' },
              at: origin.at,
              operationId: 'decide-1',
              optionId: 'blue',
            },
          ],
        },
      ],
    };
    expect(videoProjectDocumentSchema.parse(catEvent)).toEqual(catEvent);
  });

  it('retains old checks after the current page scope changes and avoids cycles across revisions', () => {
    const p = project();
    const page = p.checkPages[0];
    const value = {
      ...p,
      timeline: { ...p.timeline, scenes: [...p.timeline.scenes, { id: 'scene-2', label: '第二场' }] },
      checkPages: [
        { ...page, scope: { kind: 'selectedScenes', sceneIds: ['scene-2'] } },
        { ...page, id: 'other' },
      ],
      checkResults: [
        ...p.checkResults,
        {
          id: 'cover-1',
          kind: 'coveredBy',
          pageId: 'face',
          sceneId: 'scene-1',
          inputOwnerRevision: 2,
          definitionDigest: digest,
          coveredByPageId: 'other',
          reason: '旧定义明确覆盖',
          origin,
        },
        {
          id: 'cover-2',
          kind: 'coveredBy',
          pageId: 'other',
          sceneId: 'scene-1',
          inputOwnerRevision: 3,
          definitionDigest: digest,
          coveredByPageId: 'face',
          reason: '新版反向覆盖',
          origin,
        },
      ],
    };
    expect(videoProjectDocumentSchema.parse(value)).toEqual(value);
  });

  it('retains a historical choice after removing the old option from current options', () => {
    const p = project();
    const d = p.decisions[0];
    const value = {
      ...p,
      decisions: [
        {
          ...d,
          options: [{ id: 'red', text: '红色' }],
          state: 'open',
          history: [
            ...d.history,
            { kind: 'decided', actor, at: origin.at, operationId: 'decide-1', optionId: 'blue' },
            { kind: 'reopened', actor, at: origin.at, operationId: 'reopen-1', reason: '重新配色' },
          ],
        },
      ],
    };
    expect(videoProjectDocumentSchema.parse(value)).toEqual(value);
  });
});
