import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildMissionPack, formatMissionPackPrompt } from '../../dist/config/governance/mission-pack.js';

describe('mission-pack', () => {
  it('builds pack from thread with backlogItemId and phase', () => {
    const pack = buildMissionPack({
      title: 'Implement auth flow',
      phase: 'implementing',
      backlogItemId: 'AUTH-001',
    });
    assert.equal(pack.workItem, 'AUTH-001');
    assert.equal(pack.phase, 'implementing');
    assert.ok(pack.mission.includes('Implement auth flow'));
  });

  it('falls back to thread title when no backlogItemId', () => {
    const pack = buildMissionPack({ title: 'Fix login bug' });
    assert.equal(pack.workItem, 'Fix login bug');
    assert.equal(pack.phase, 'unknown');
  });

  it('formats prompt block with all fields', () => {
    const prompt = formatMissionPackPrompt({
      mission: 'Implement OAuth2 login',
      workItem: 'AUTH-001',
      phase: 'implementing',
      doneWhen: ['Login endpoint returns JWT', 'Tests pass'],
      links: ['docs/features/F001-auth.md'],
    });
    assert.ok(prompt.includes('mission:'));
    assert.ok(prompt.includes('AUTH-001'));
    assert.ok(prompt.includes('implementing'));
    assert.ok(prompt.includes('Login endpoint returns JWT'));
    assert.ok(prompt.includes('docs/features/F001-auth.md'));
  });

  it('handles empty doneWhen and links gracefully', () => {
    const prompt = formatMissionPackPrompt({
      mission: 'Quick fix',
      workItem: 'thread title',
      phase: 'unknown',
      doneWhen: [],
      links: [],
    });
    assert.ok(prompt.includes('mission:'));
    assert.ok(!prompt.includes('done_when:'));
    assert.ok(!prompt.includes('links:'));
  });

  // clowder-ai#1037 accepted scope: do not inject M1 when there is no concrete
  // mission/work-item content. Only `title` and `backlogItemId` can supply that
  // — `phase` alone leaves `mission` / `work_item` as placeholders
  // ('External project task' / 'unspecified'), which is the reporter's failure
  // mode. So phase is NOT an injection anchor by itself.
  it('returns null when thread has no title and no backlogItemId', () => {
    assert.equal(buildMissionPack({}), null);
    assert.equal(buildMissionPack({ title: undefined, phase: undefined, backlogItemId: undefined }), null);
  });

  it('returns null when title and backlogItemId are whitespace-only', () => {
    assert.equal(buildMissionPack({ title: '   ', phase: '\t', backlogItemId: '\n' }), null);
  });

  it('returns null when only phase is present (phase cannot carry mission/work-item)', () => {
    assert.equal(buildMissionPack({ phase: 'implementing' }), null);
    assert.equal(buildMissionPack({ phase: 'implementing', title: '  ', backlogItemId: '' }), null);
  });

  it('builds a pack when title or backlogItemId is present', () => {
    const titleOnly = buildMissionPack({ title: 'Fix login bug' });
    assert.ok(titleOnly);
    assert.equal(titleOnly.mission, 'Fix login bug');
    assert.equal(titleOnly.workItem, 'Fix login bug');

    const backlogOnly = buildMissionPack({ backlogItemId: 'AUTH-001' });
    assert.ok(backlogOnly);
    assert.equal(backlogOnly.workItem, 'AUTH-001');
    // mission still falls back to placeholder when no title, but the model now
    // has a concrete work_item anchor so the block is not "empty".
    assert.equal(backlogOnly.mission, 'External project task');

    const titleAndPhase = buildMissionPack({ title: 'Fix login bug', phase: 'implementing' });
    assert.ok(titleAndPhase);
    assert.equal(titleAndPhase.mission, 'Fix login bug');
    assert.equal(titleAndPhase.phase, 'implementing');
  });
});
