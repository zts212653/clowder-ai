/**
 * F098: Parse direction info from a chat message for display as a pill badge.
 * Priority: whisper > crossPost > @mention in content.
 */

import { findLineStartMentions, isCrossThreadProvenance, MAX_A2A_MENTION_TARGETS } from '@cat-cafe/shared';
import { getUnavailableMentionToCat } from './mention-highlight';

export interface DirectionInfo {
  type: 'mention' | 'crossPost' | 'whisper';
  targets: string[];
  arrow: '→' | '↗';
}

interface MessageLike {
  origin?: 'stream' | 'callback' | 'briefing';
  /** The sender. A cat never routes to itself, so its own handles are not targets. */
  catId?: string | null;
  content: string;
  visibility?: 'public' | 'whisper';
  whisperTo?: string[];
  extra?: { crossPost?: { sourceThreadId: string }; targetCats?: string[]; isExplicitPost?: boolean };
  source?: { connector?: string; meta?: { targets?: string[]; initiator?: string } };
}

const CO_CREATOR_ID = '__co-creator__';

/**
 * The cats this text addresses in the A2A grammar the API routes with (shared: line-start
 * handles only, no code blocks), over the cat handles the client knows. Like the API, a
 * disabled member's handle is matched and then dropped, so the line goes on past it. The
 * co-creator handle is not a routing target, and a cat never routes to itself.
 */
export function parseContentDirectionTargets(
  content: string,
  getMentionData: () => MentionData,
  senderCatId?: string | null,
): string[] {
  const { toCat, unavailableToCat = getUnavailableMentionToCat() } = getMentionData();
  const unavailable = new Set(Object.values(unavailableToCat));
  const handles = Object.entries({ ...unavailableToCat, ...toCat })
    .filter(([, catId]) => catId !== CO_CREATOR_ID && catId !== senderCatId)
    .map(([alias, catId]) => ({ catId, pattern: `@${alias}` }));
  return [...new Set(findLineStartMentions(content, handles))].filter((catId) => !unavailable.has(catId));
}

/**
 * Structured post_message targets are routing facts even when the authored
 * body does not contain an @ line. Project only the otherwise-invisible part;
 * body mentions already explain themselves and must not be duplicated.
 */
export function parseImplicitStructuredTargets(message: MessageLike, getMentionData: () => MentionData): string[] {
  if (!message.extra?.targetCats?.length) return [];
  const visibleTargets = new Set(parseContentDirectionTargets(message.content, getMentionData, message.catId));
  return [...new Set(message.extra.targetCats)].filter((catId) => !visibleTargets.has(catId));
}

interface MentionData {
  toCat: Record<string, string>;
  /** Disabled members' handles; defaults to the client's cat data (getUnavailableMentionToCat). */
  unavailableToCat?: Record<string, string>;
}

export function parseDirection(
  message: MessageLike,
  getMentionData: () => MentionData,
  currentThreadId?: string,
): DirectionInfo | null {
  // Whisper — highest priority, has explicit targets
  if (message.visibility === 'whisper' && message.whisperTo?.length) {
    return { type: 'whisper', targets: message.whisperTo, arrow: '→' };
  }

  // CrossPost — has source thread metadata
  if (isCrossThreadProvenance(message.extra?.crossPost?.sourceThreadId, currentThreadId)) {
    const shortId = message.extra.crossPost.sourceThreadId.replace(/^thread_/, '').slice(0, 8);
    return { type: 'crossPost', targets: [shortId], arrow: '↗' };
  }

  // F098-C2: Connector messages with explicit targets metadata (e.g. multi-mention-result)
  if (message.source?.meta?.targets?.length) {
    return { type: 'mention', targets: message.source.meta.targets, arrow: '→' };
  }

  // F098-C1: Explicit targetCats from post_message API (takes priority over content parsing)
  if (message.extra?.targetCats?.length) {
    return { type: 'mention', targets: message.extra.targetCats, arrow: '→' };
  }

  // Stream messages don't need direction (catId in header is enough)
  if (message.origin === 'stream') return null;

  // Only parse @mentions for callback messages
  if (message.origin !== 'callback') return null;

  // The API routes at most MAX_A2A_MENTION_TARGETS cats from the text; the badge shows those.
  const targets = parseContentDirectionTargets(message.content, getMentionData, message.catId).slice(
    0,
    MAX_A2A_MENTION_TARGETS,
  );
  return targets.length > 0 ? { type: 'mention', targets, arrow: '→' } : null;
}
