import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_READING, openEvolutionReading, useEvolutionReading } from '../evolution-reading-state';
import { DEFAULT_EXPLORATION, type ExplorationReading } from '../exploration/exploration-reading';
import { assetRef, PROGRAM_ID } from './evolution-fixtures';

describe('exploration reading persistence', () => {
  beforeEach(() => {
    localStorage.clear();
    useEvolutionReading.setState({ programs: {} });
  });
  it('restores the selected experiment, explicit comparison scope, viewport and unfinished input', async () => {
    const exploration: ExplorationReading = {
      selectedNodeRef: { ownerFeatureId: 'F100', ownerStateRef: 'source:node-v1', version: 'v1' },
      selectedExperimentRef: { ownerFeatureId: 'F100', ownerStateRef: 'source:experiment-a', version: 'v1' },
      comparisonExperimentRef: { ownerFeatureId: 'F100', ownerStateRef: 'source:experiment-b', version: 'v1' },
      comparisonScope: 'paired_subset',
      selectedCaseId: 'anonymous',
      viewport: { x: 72, y: -16, zoom: 1.25, collapsed: [] },
      draft: { text: '请核对陌生输入 sentinel-7f13 的超时行为', intent: 'explore' },
    };
    useEvolutionReading.getState().update(PROGRAM_ID, { exploration });
    const persisted = localStorage.getItem('f311-program-reading-v1')!;
    useEvolutionReading.setState({ programs: {} });
    localStorage.setItem('f311-program-reading-v1', persisted);
    await useEvolutionReading.persist.rehydrate();
    expect(useEvolutionReading.getState().programs[PROGRAM_ID]).toHaveProperty('exploration', exploration);
  });
  it('exact source navigation overrides a stale archive selection without discarding the unfinished draft', () => {
    const exploration: ExplorationReading = {
      selectedNodeRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: 'archive:v3', version: 'a' },
      selectedExperimentRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: 'run:old', version: 'a' },
      comparisonScope: 'full',
      viewport: { x: 0, y: 0, zoom: 1, collapsed: [] },
      draft: { text: '仍应保留的想法', intent: 'explore' },
    };
    useEvolutionReading.getState().update(PROGRAM_ID, { exploration });
    openEvolutionReading(PROGRAM_ID, 'judgment', assetRef('v2'));
    const saved = useEvolutionReading.getState().programs[PROGRAM_ID];
    expect(saved?.exploration?.selectedNodeRef).toBeUndefined();
    expect(saved?.exploration?.selectedExperimentRef).toBeUndefined();
    expect(saved?.exploration?.draft.text).toBe('仍应保留的想法');
  });

  it('recovers each Program and reading field without losing valid drafts or paired-scope consent', async () => {
    const exploration: ExplorationReading = {
      ...DEFAULT_EXPLORATION,
      selectedNodeRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: 'archive:v3', version: 'a' },
      selectedExperimentRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: 'run:v3', version: 'a' },
      comparisonScope: 'paired_subset',
      comparisonScopeKey: 'explicitly-confirmed-pair',
      draft: {
        text: '未发出的输入必须保留',
        intent: 'retest',
        binding: {
          kind: 'public_archive',
          nodeRef: { ownerFeatureId: 'microduck-owner', ownerStateRef: 'archive:v3', version: 'a' },
          title: '原来的公开 v3',
        },
      },
    };
    const good = { ...DEFAULT_READING, selectedVersionRef: assetRef('v2'), exploration };
    const programs = {
      healthy: good,
      invalidViewport: {
        ...good,
        exploration: { ...exploration, viewport: { ...exploration.viewport, collapsed: Array(513).fill('old-node') } },
      },
      invalidVersion: { ...good, selectedVersionRef: { version: 'bad-ref' } },
      invalidEntry: null,
    };
    localStorage.setItem('f311-program-reading-v1', JSON.stringify({ state: { programs }, version: 0 }));
    await useEvolutionReading.persist.rehydrate();
    const saved = useEvolutionReading.getState().programs;
    expect(saved.healthy).toEqual(good);
    expect(saved.invalidViewport?.exploration).toEqual({ ...exploration, viewport: DEFAULT_EXPLORATION.viewport });
    expect(saved.invalidVersion?.selectedVersionRef).toBeUndefined();
    expect(saved.invalidVersion?.exploration).toEqual(exploration);
    expect(saved.invalidEntry).toBeUndefined();
    useEvolutionReading.getState().update('healthy', { view: 'history' });
    const persisted = JSON.parse(localStorage.getItem('f311-program-reading-v1')!).state.programs;
    expect(persisted.invalidViewport.exploration.draft).toEqual(exploration.draft);
    expect(persisted.invalidViewport.exploration.comparisonScopeKey).toBe('explicitly-confirmed-pair');
  });
});
