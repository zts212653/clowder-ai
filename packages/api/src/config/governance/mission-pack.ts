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
 *
 * Returns `null` when the thread has no concrete mission/work-item content
 * (clowder-ai#1037 accepted scope). Only `title` and `backlogItemId` can supply
 * that content — `phase` alone leaves `mission` / `work_item` as placeholders
 * ('External project task' / 'unspecified'), which the model interprets as
 * "dispatcher sent the marker but forgot the task body". So `phase` by itself
 * is NOT an injection anchor.
 */
export function buildMissionPack(thread: ThreadContext): DispatchMissionPack | null {
  const title = thread.title?.trim() ? thread.title.trim() : undefined;
  const phase = thread.phase?.trim() ? thread.phase.trim() : undefined;
  const backlogItemId = thread.backlogItemId?.trim() ? thread.backlogItemId.trim() : undefined;

  // Anchor set: only fields that can supply concrete mission/work-item content.
  if (!title && !backlogItemId) {
    return null;
  }

  return {
    mission: title ?? 'External project task',
    workItem: backlogItemId ?? title ?? 'unspecified',
    phase: phase ?? 'unknown',
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
