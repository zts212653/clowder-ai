export const digest = `sha256:${'a'.repeat(64)}`;
export const actor = { kind: 'human' as const, actorId: 'owner' };
export const origin = { kind: 'imported' as const, actor: null, at: '2026-10-08T03:00:00.000Z', refs: ['source:1'] };

export function project() {
  return {
    schemaVersion: 1 as const,
    title: '  原文标题  ',
    kind: 'animation',
    tags: ['family'],
    roles: [{ role: 'director', actor }],
    origin,
    timeline: {
      timebase: { numerator: 1, denominator: 30 },
      durationTicks: 300,
      width: 1920,
      height: 1080,
      scenes: [{ id: 'scene-1', label: '第一场' }],
      segments: [
        {
          id: 'shot-1',
          kind: 'shot' as const,
          sceneId: 'scene-1',
          label: '开场',
          startTick: 0,
          durationTicks: 100,
          switchMode: 'explicit' as const,
          visuals: [{ id: 'visual-1', assetVersionRef: 'image-v1', startTick: 0, endTick: 100 }],
        },
      ],
      events: [
        { id: 'sound-1', kind: 'audio' as const, startTick: 290, durationTicks: 20, assetVersionRef: 'image-v1' },
      ],
      extensions: [{ namespace: 'future.renderer', schemaVersion: 3, payload: { gain: 0.6, nested: [null, true] } }],
    },
    assets: [
      {
        id: 'image',
        name: '原图',
        kind: 'image',
        versions: [
          {
            id: 'image-v1',
            mediaType: 'image/png',
            byteLength: 12,
            sha256: digest,
            locator: { kind: 'workspace' as const, rootId: 'registered-root', path: 'images/one.png' },
            recordedAt: origin.at,
            origin,
            width: 1920,
            height: 1080,
          },
        ],
      },
    ],
    checkPages: [
      {
        id: 'face',
        name: '  脸部检查  ',
        criteria: '看眼神',
        references: ['image-v1'],
        scope: { kind: 'allScenes' as const },
        assignee: actor,
        origin,
      },
    ],
    checkResults: [
      {
        id: 'sheet-1',
        kind: 'sheet' as const,
        pageId: 'face',
        sceneId: 'scene-1',
        inputOwnerRevision: 1,
        definitionDigest: digest,
        assetVersionRefs: ['image-v1'],
        origin,
      },
    ],
    decisions: [
      {
        id: 'choice',
        question: '颜色？',
        context: '片子设定',
        options: [{ id: 'blue', text: '蓝色', assetVersionRefs: ['image-v1'] }],
        targets: { sceneIds: ['scene-1'], segmentIds: ['shot-1'], assetIds: ['image'] },
        proposer: actor,
        decider: actor,
        origin,
        state: 'open' as const,
        history: [{ kind: 'proposed' as const, actor, at: origin.at, operationId: 'propose-1' }],
      },
    ],
  } as const;
}
