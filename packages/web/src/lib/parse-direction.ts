/**
 * F098: Parse direction info from a chat message for display as a pill badge.
 * Priority: whisper > crossPost > @mention in content.
 */

import { isCrossThreadProvenance } from '@cat-cafe/shared';

export interface DirectionInfo {
  type: 'mention' | 'crossPost' | 'whisper';
  targets: string[];
  arrow: '→' | '↗';
}

interface MessageLike {
  origin?: 'stream' | 'callback' | 'briefing';
  content: string;
  visibility?: 'public' | 'whisper';
  whisperTo?: string[];
  extra?: { crossPost?: { sourceThreadId: string }; targetCats?: string[]; isExplicitPost?: boolean };
  source?: { connector?: string; meta?: { targets?: string[]; initiator?: string } };
}

const LEADING_MARKDOWN_MENTION_PREFIX_RE = /^(?:(?:>\s*)|(?:[-*+]\s+)|(?:\d+[.)]\s+))+/;

/**
 * Match the server's actionable A2A grammar: only line-start mentions route.
 * This intentionally does not treat prose such as "ask @opus" as a visible
 * dispatch target.
 */
export function parseContentDirectionTargets(content: string, getMentionData: () => MentionData): string[] {
  const { toCat, re } = getMentionData();
  const found = new Set<string>();
  const stripped = content.replace(/```[\s\S]*?```/g, '');

  for (const rawLine of stripped.split(/\r?\n/)) {
    const normalized = rawLine.trimStart().replace(LEADING_MARKDOWN_MENTION_PREFIX_RE, '');
    if (!normalized.startsWith('@')) continue;

    re.lastIndex = 0;
    for (let match = re.exec(normalized); match !== null; match = re.exec(normalized)) {
      const alias = match[1].toLowerCase();
      const catId = toCat[alias];
      if (catId && catId !== '__co-creator__') found.add(catId);
    }
  }

  return [...found];
}

/**
 * Structured post_message targets are routing facts even when the authored
 * body does not contain an @ line. Project only the otherwise-invisible part;
 * body mentions already explain themselves and must not be duplicated.
 */
export function parseImplicitStructuredTargets(message: MessageLike, getMentionData: () => MentionData): string[] {
  if (!message.extra?.targetCats?.length) return [];
  const visibleTargets = new Set(parseContentDirectionTargets(message.content, getMentionData));
  return [...new Set(message.extra.targetCats)].filter((catId) => !visibleTargets.has(catId));
}

interface MentionData {
  toCat: Record<string, string>;
  re: RegExp;
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

  const { toCat, re } = getMentionData();
  const found = new Set<string>();
  re.lastIndex = 0;
  for (let match = re.exec(message.content); match !== null; match = re.exec(message.content)) {
    const alias = match[1].toLowerCase();
    const catId = toCat[alias];
    if (catId && catId !== '__co-creator__') found.add(catId);
  }

  if (found.size > 0) {
    return { type: 'mention', targets: [...found], arrow: '→' };
  }

  return null;
}
