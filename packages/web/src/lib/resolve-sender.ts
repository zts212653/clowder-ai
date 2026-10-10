/**
 * Unified sender resolution — co-creator is a first-class member.
 *
 * Replaces the repeated `senderCatId === null ? coCreator : getCatById(...)` branching
 * scattered across ReplyPill, ReplyPreviewBar, SummaryCard, MessageNavigator, etc.
 *
 * Usage:
 *   const sender = resolveSender(senderCatId, getCatById, coCreator);
 *   // sender.label  → "宪宪" | "始皇帝" | "unknown-cat"
 *   // sender.color  → resolved primary color (the identity fill), always non-null
 *   // sender.textColor → the colour to write text in: the readable name role for the co-creator, else the cat colour
 */

import {
  type ConnectorIconSpec,
  type ConnectorSource,
  getConnectorDefinition,
  type MessageFrom,
} from '@cat-cafe/shared';
import type { CoCreatorConfig } from '@/components/config-viewer-types';
import type { CatData } from '@/hooks/useCatData';
import { formatCatDisplayName } from '@/lib/cat-display-name';
import { CO_CREATOR_COLOR, UNKNOWN_CAT_COLOR } from '@/lib/color-defaults';

export interface SenderMeta {
  /** Display name only; routing @handles belong to message content, not this label. */
  label: string;
  /** Resolved primary color — always a valid hex string. An identity fill, which may be dark in a dark theme. */
  color: string;
  /**
   * The colour to write text in, as a CSS colour. A cat's identity colour doubles as its text colour; the co-creator's is
   * configurable (and cocoa by default), so their text uses the shared name role, which the theme keeps readable.
   */
  textColor: string;
  /** true when the canonical sender is the co-creator */
  isCoCreator: boolean;
  avatar?: string;
  icon?: ConnectorIconSpec;
  fallbackIcon?: string;
}

export interface MessageSenderIdentity {
  from?: MessageFrom;
  source?: ConnectorSource;
}

/** Display projection only. Source labels describe transport, never grant actor identity or authority. */
export function resolveMessageSender(
  message: MessageSenderIdentity,
  getCatById: (id: string) => CatData | undefined,
  coCreator: CoCreatorConfig,
): SenderMeta {
  const from = message.from;
  if (from?.kind === 'user') return { ...resolveSender(null, getCatById, coCreator), avatar: coCreator.avatar };
  const catId = from?.kind === 'agent' ? from.catId : undefined;
  if (catId) return { ...resolveSender(catId, getCatById, coCreator), avatar: getCatById(catId)?.avatar };
  const source =
    from && (from.kind !== 'external' || message.source?.connector === from.connectorId) ? message.source : undefined;
  const connectorId = from?.kind === 'external' ? from.connectorId : source?.connector;
  const definition = connectorId ? getConnectorDefinition(connectorId) : undefined;
  const sourceName = source?.label || definition?.displayName || connectorId;
  const actor = from?.kind === 'external' ? from.sender : undefined;
  const actorName = actor?.name || actor?.id;
  const label = sourceName
    ? actorName
      ? `${sourceName} · ${actorName}`
      : sourceName
    : from?.kind === 'plugin'
      ? `Plugin · ${from.instanceId}`
      : from?.kind === 'system'
        ? from.service
        : '未知来源';
  const color = definition?.themeColor ?? '#64748B';
  return {
    label,
    color,
    textColor: color,
    isCoCreator: false,
    icon: definition?.icon ?? (source?.icon ? undefined : { type: 'svg', iconId: 'robot' }),
    ...(source?.icon ? { fallbackIcon: source.icon } : {}),
  };
}

/**
 * Resolve any senderCatId to display metadata.
 *
 * - `null` → co-creator (co-creator is a member too)
 * - known catId → cat display name + cat color
 * - unknown catId → raw ID + fallback color
 */
export function resolveSender(
  senderCatId: string | null,
  getCatById: (id: string) => CatData | undefined,
  coCreator: CoCreatorConfig,
): SenderMeta {
  // Co-creator — first-class member, not a "null fallback"
  if (senderCatId === null) {
    return {
      label: coCreator.name,
      color: coCreator.color?.primary ?? CO_CREATOR_COLOR.primary,
      textColor: 'var(--color-cocreator-text)',
      isCoCreator: true,
    };
  }

  // Known cat
  const cat = getCatById(senderCatId);
  if (cat) {
    return {
      label: formatCatDisplayName(cat),
      color: cat.color.primary,
      textColor: cat.color.primary,
      isCoCreator: false,
    };
  }

  // Unknown cat ID
  return {
    label: senderCatId,
    color: UNKNOWN_CAT_COLOR.primary,
    textColor: UNKNOWN_CAT_COLOR.primary,
    isCoCreator: false,
  };
}
