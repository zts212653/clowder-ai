'use client';

import { type ExactAssetVersionRefV1, exactAssetVersionRefV1Schema } from '@cat-cafe/shared';
import { useChatStore } from '@/stores/chatStore';
import { type EvolutionReadingView, openEvolutionReading } from './evolution-reading-state';

export interface EvolutionReadingTarget {
  programId: string;
  versionRef?: ExactAssetVersionRefV1;
  view: EvolutionReadingView;
}

export function readEvolutionTarget(url: URL): EvolutionReadingTarget | undefined {
  const programId = url.searchParams.get('evolutionProgram');
  if (!programId || !/^evolution-program:[0-9a-f]{32}$/.test(programId)) return undefined;
  const view = url.searchParams.get('evolutionView') ?? 'judgment';
  if (view !== 'history' && view !== 'judgment') return undefined;
  const raw = url.searchParams.get('evolutionVersion');
  if (raw === null) return { programId, view };
  if (raw.length > 4_000) return undefined;
  try {
    const versionRef = exactAssetVersionRefV1Schema.parse(JSON.parse(raw));
    return { programId, view, versionRef };
  } catch {
    return undefined;
  }
}

export function evolutionReadingHref(target: EvolutionReadingTarget, baseHref: string): string {
  const url = new URL(baseHref);
  url.searchParams.set('evolutionProgram', target.programId);
  url.searchParams.set('evolutionView', target.view);
  if (target.versionRef) url.searchParams.set('evolutionVersion', JSON.stringify(target.versionRef));
  else url.searchParams.delete('evolutionVersion');
  return url.href;
}

export function openEvolutionTarget(target: EvolutionReadingTarget): void {
  openEvolutionReading(target.programId, target.view, target.versionRef);
  useChatStore.getState().openEvolutionProgram(target.programId);
}

export function hydrateEvolutionFromCurrentUrl(): void {
  const url = new URL(window.location.href);
  const target = readEvolutionTarget(url);
  if (!target) return;
  openEvolutionTarget(target);
  // An explicit source intent is consumed once. Ordinary return must preserve the reader's next choice.
  for (const name of ['evolutionProgram', 'evolutionView', 'evolutionVersion']) url.searchParams.delete(name);
  window.history.replaceState(window.history.state, '', url);
}
