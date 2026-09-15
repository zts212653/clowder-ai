import { describe, expect, it } from 'vitest';
import {
  evolutionProgramPresentation,
  parseEvolutionProgramProjection,
  preparationGaps,
  productStatus,
} from '../capability-evolution-presentation';
import { programFixture } from './evolution-fixtures';

describe('F311 capability evolution presentation adapter', () => {
  it('explains the next missing observation instead of showing an unexplained aggregate', () => {
    const projection = programFixture('instrumenting');
    expect(
      productStatus({
        ...projection,
        observation: {
          ...projection.observation,
          gaps: [
            { code: 'trajectory_ref_missing', message: 'missing trajectory', ownerFeatureId: 'F299' },
            { code: 'trigger_registration_missing', message: 'missing trigger', ownerFeatureId: 'F192' },
          ],
        },
      }).description,
    ).toBe('还需要：补充真实任务的执行记录、设置自动检查条件。');
  });

  it('counts the same owner condition once across the Program and observation projections', () => {
    const projection = programFixture('instrumenting');
    expect(
      productStatus({
        ...projection,
        blockers: [{ code: 'trajectory_ref_missing', message: 'missing trajectory', ownerFeatureId: 'F299' }],
        observation: {
          ...projection.observation,
          gaps: [{ code: 'trajectory_ref_missing', message: 'missing trajectory', ownerFeatureId: 'F299' }],
        },
      }).description,
    ).toBe('还需要：补充真实任务的执行记录。');
  });
  it('uses the canonical name without interpreting an opaque asset reference', () => {
    const program = programFixture().program;
    program.displayName = '多语言解释能力';
    program.objectRef.ownerStateRef = 'capability:new-untranslated-slug';
    expect(evolutionProgramPresentation(program).title).toBe('多语言解释能力');
    const { displayName, ...unnamed } = program;
    void displayName;
    expect(evolutionProgramPresentation(unnamed).title).toBe('未命名项目');
    expect(evolutionProgramPresentation(unnamed).title).not.toContain('Slug');
  });

  it('keeps goal preparation separate from later observation requirements', () => {
    const base = programFixture('constituting');
    const projection = {
      ...base,
      blockers: [{ code: 'goal_certificate_missing', message: 'goal missing', ownerFeatureId: 'F311' }],
      observation: {
        ...base.observation,
        gaps: [{ code: 'trajectory_ref_missing', message: 'trajectory missing', ownerFeatureId: 'F299' }],
      },
    };
    expect(productStatus(projection)).toMatchObject({ label: '准备目标', description: '还需要：明确要改进什么。' });
    expect(preparationGaps(projection).map((gap) => gap.code)).toEqual(['goal_certificate_missing']);
    const readyGoal = {
      ...projection,
      program: { ...projection.program, stage: 'instrumenting' as const },
      blockers: [],
    };
    expect(productStatus(readyGoal).label).toBe('准备评估');
  });

  it('retains verified conversation context without assigning it to Program metadata', () => {
    const projection = programFixture();
    const origin = { threadId: 'thread-original', title: '让审阅更贴近原始需求' };
    const parsed = parseEvolutionProgramProjection({
      ...projection,
      program: { ...projection.program, displayName: undefined },
      origin,
    });
    expect(parsed?.origin).toEqual(origin);
    expect(parsed?.program.displayName).toBeUndefined();
    expect(
      parseEvolutionProgramProjection({ ...projection, origin: { threadId: '../secret', title: 'fake' } }),
    ).toBeNull();
  });

  it('rejects malformed list members instead of inventing a local projection', () => {
    expect(parseEvolutionProgramProjection({ program: { programId: 'not-canonical' } })).toBeNull();
  });
});
