export const projectHumanFixture = { userId: 'operator', actor: { kind: 'human' as const, actorId: 'operator' } };
export const projectDocumentFixture = {
  schemaVersion: 1,
  title: 'EP0 test',
  kind: 'animation',
  tags: [],
  roles: [],
  origin: { kind: 'created', actor: projectHumanFixture.actor, at: '2026-10-08T00:00:00.000Z', refs: [] },
  timeline: {
    timebase: { numerator: 1, denominator: 30 },
    durationTicks: 120,
    width: 1920,
    height: 1080,
    scenes: [{ id: 's1', label: '第一场' }],
    segments: [
      { id: 'C01', kind: 'shot', sceneId: 's1', label: '开场', startTick: 0, durationTicks: 120, visuals: [] },
    ],
    events: [],
  },
  assets: [],
  checkPages: [],
  checkResults: [],
  decisions: [],
};
