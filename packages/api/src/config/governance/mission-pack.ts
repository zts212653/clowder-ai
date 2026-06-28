/**
 * F070 Phase 2: Dispatch Mission Pack
 *
 * Builds structured mission context from thread metadata and formats
 * it for system prompt injection when dispatching cats to external projects.
 */
import type { DispatchMissionPack } from '@cat-cafe/shared';
import { renderSegment } from '../../domains/cats/services/context/prompt-template-loader.js';

export interface ThreadContext {
  title?: string | undefined;
  phase?: string | undefined;
  backlogItemId?: string | undefined;
}

/**
 * Build a structured mission pack from thread metadata.
 * This is injected into the system prompt when dispatching to external projects.
 */
export function buildMissionPack(thread: ThreadContext): DispatchMissionPack {
  return {
    mission: thread.title ?? 'External project task',
    workItem: thread.backlogItemId ?? thread.title ?? 'unspecified',
    phase: thread.phase ?? 'unknown',
    doneWhen: [],
    links: [],
  };
}

/**
 * Format mission pack as a prompt block for system prompt injection.
 * Template: assets/prompt-templates/m1-dispatch-mission.md
 */
export function formatMissionPackPrompt(pack: DispatchMissionPack): string {
  const doneWhenBlock =
    pack.doneWhen.length > 0 ? ['done_when:', ...pack.doneWhen.map((c) => `  - ${c}`)].join('\n') : '';
  const linksBlock = pack.links.length > 0 ? ['links:', ...pack.links.map((l) => `  - ${l}`)].join('\n') : '';

  return (
    renderSegment('M1', {
      MISSION: pack.mission,
      WORK_ITEM: pack.workItem,
      PHASE: pack.phase,
      DONE_WHEN_BLOCK: doneWhenBlock,
      LINKS_BLOCK: linksBlock,
    }) ?? ''
  );
}
