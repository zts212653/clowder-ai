import type { EvolutionMediaLocator } from '@cat-cafe/shared';
import { DEFAULT_READING, useEvolutionReading } from '@/components/capability-evolution/evolution-reading-state';
import { DEFAULT_EXPLORATION } from '@/components/capability-evolution/exploration/exploration-reading';
import type { WorkspaceFileNavigationOrigin } from '@/stores/chat-types';
import { useChatStore } from '@/stores/chatStore';
import {
  createEvolutionMediaSurface,
  evolutionMediaReadingSchema,
  validEvolutionMediaOrigin,
} from './evolution-media-surface';
import { useF307ExperienceWorkbenchStore } from './experience-workbench-store';
import { createEvolutionProgramSurface } from './real-surface-adapters';

export function openEvolutionMedia(locator: EvolutionMediaLocator, title: string) {
  const store = useF307ExperienceWorkbenchStore.getState(),
    reading = useEvolutionReading.getState().programs[locator.programId] ?? DEFAULT_READING;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- the reading origin never carries the draft
  const { draft: _draft, ...exploration } = reading.exploration ?? DEFAULT_EXPLORATION;
  const origin: WorkspaceFileNavigationOrigin = {
    kind: 'evolution-media',
    programId: locator.programId,
    expanded: store.mainAreaAttentionSurfaceId === createEvolutionProgramSurface(locator.programId).id,
    readingState: JSON.stringify(
      evolutionMediaReadingSchema.parse({
        selectedVersionRef: reading.selectedVersionRef,
        exploration,
        view: reading.view,
        scroll: reading.scroll,
      }),
    ),
  };
  useChatStore.getState().setWorkspaceMode('dev');
  store.exitMainAreaAttention();
  store.dispatch({
    type: 'open-surface',
    surface: createEvolutionMediaSurface(locator, title, origin),
    entitlement: { kind: 'user', reason: 'open-from-chat' },
  });
}
export function restoreEvolutionMediaOrigin(
  origin: Extract<WorkspaceFileNavigationOrigin, { kind: 'evolution-media' }>,
) {
  if (!validEvolutionMediaOrigin(origin)) return null;
  const saved = evolutionMediaReadingSchema.parse(JSON.parse(origin.readingState));
  const current = useEvolutionReading.getState().programs[origin.programId];
  useEvolutionReading.getState().update(origin.programId, {
    ...saved,
    selectedVersionRef: saved.selectedVersionRef,
    exploration: { ...saved.exploration, draft: current?.exploration?.draft ?? DEFAULT_EXPLORATION.draft },
  });
  return createEvolutionProgramSurface(origin.programId);
}
