import { afterEach, expect, it } from 'vitest';
import { DEFAULT_READING, useEvolutionReading } from '@/components/capability-evolution/evolution-reading-state';
import { DEFAULT_EXPLORATION } from '@/components/capability-evolution/exploration/exploration-reading';
import { openEvolutionMedia, restoreEvolutionMediaOrigin } from '../evolution-media-navigation';
import { resolveEvolutionMediaTarget } from '../evolution-media-surface';
import { useF307ExperienceWorkbenchStore } from '../experience-workbench-store';
import { createEvolutionProgramSurface, isRealSurfaceOwnerAvailable } from '../real-surface-adapters';
import { createInitialWorkbenchState, restoreWorkbenchState } from '../workbench-model';

const programId = 'evolution-program:' + 'a'.repeat(32);
const ref = (name: string, version = 'v1') => ({ ownerFeatureId: 'F311', ownerStateRef: 'record:' + name, version });
const locator = {
  programId,
  experimentRef: ref('left'),
  recordRef: ref('left-case'),
  mediaRef: ref('image', 'b'.repeat(64)),
};
afterEach(() => {
  useEvolutionReading.setState({ programs: {} });
  useF307ExperienceWorkbenchStore.setState({ layout: createInitialWorkbenchState(), mainAreaAttentionSurfaceId: null });
});
it('opens the common surface beside chat and restores the exact comparison after reload, retaining newer author text', () => {
  const reading = {
    ...DEFAULT_READING,
    exploration: {
      ...DEFAULT_EXPLORATION,
      selectedExperimentRef: ref('right'),
      comparisonExperimentRef: ref('left'),
      selectedCaseId: 'hard-case',
      comparisonScope: 'paired_subset' as const,
      comparisonScopeKey: 'selected-pair',
      draft: { text: 'before', intent: 'explore' as const },
    },
  };
  useEvolutionReading.setState({ programs: { [programId]: reading } });
  useF307ExperienceWorkbenchStore.setState({
    layout: createInitialWorkbenchState(),
    mainAreaAttentionSurfaceId: createEvolutionProgramSurface(programId).id,
  });
  openEvolutionMedia(locator, '左侧原件');
  const current = useF307ExperienceWorkbenchStore.getState();
  expect(current.mainAreaAttentionSurfaceId).toBeNull();
  const surface = current.layout.surfaces.find((item) => item.ownerStateRef.owner === 'f311-media')!;
  expect(resolveEvolutionMediaTarget(surface)).toEqual(locator);
  const restored = restoreWorkbenchState(
    { ...current.layout, surfaces: [surface], activeSurfaceId: surface.id },
    { isOwnerRefAvailable: isRealSurfaceOwnerAvailable },
  );
  expect(restored.surfaces).toEqual([surface]);
  const origin = restored.surfaces[0]!.navigationOrigin!;
  if (origin.kind !== 'evolution-media') throw new Error('missing original navigation');
  useEvolutionReading.getState().update(programId, {
    exploration: {
      ...DEFAULT_EXPLORATION,
      selectedCaseId: 'elsewhere',
      draft: { text: 'new unsent intent', intent: 'explore' },
    },
  });
  expect(restoreEvolutionMediaOrigin(origin)?.id).toBe(createEvolutionProgramSurface(programId).id);
  const returned = useEvolutionReading.getState().programs[programId]!.exploration!;
  expect(returned.selectedExperimentRef).toEqual(ref('right'));
  expect(returned.comparisonExperimentRef).toEqual(ref('left'));
  expect(returned.selectedCaseId).toBe('hard-case');
  expect(returned.comparisonScope).toBe('paired_subset');
  expect(returned.draft.text).toBe('new unsent intent');
  expect(origin.expanded).toBe(true);
  expect(resolveEvolutionMediaTarget({ ...surface, objectRef: { kind: 'artifact', id: 'forged' } })).toBeNull();
});
