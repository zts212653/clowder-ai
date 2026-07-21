/**
 * F267: Channel-level Single Identity Binding
 *
 * Per-channel identity override — when a channel (e.g. feishu group) has
 * a configured display identity, all cat-cafe cats respond under that
 * single identity instead of their individual roster names.
 *
 * External collaborators only see "咖啡猫", not 砚砚/小狸/宪宪/etc.
 *
 * Phase 1 — mechanism layer (OutboundDeliveryHook enforces).
 * Phase 2 — prompt layer (SystemPromptBuilder injects identity pin).
 * Phase 3 — observability (IM Hub audit dashboard).
 */

export interface ChannelIdentity {
  /** Display name shown to external recipients, e.g. "咖啡猫" */
  readonly displayName: string;
  /** Optional emoji prefix, e.g. "🐱". Defaults to "🐱". */
  readonly emoji?: string;
  /** Allow internal cat names (砚砚/小狸/etc.) in self-references.
   *  Default false (KD-5). */
  readonly exposeInternalNames?: boolean;
}

/**
 * Default identities applied when explicit registration is missing.
 * Conservative: only feishu group gets a fallback override.
 * DM keeps the cat's own displayName (KD-2).
 */
export const CHANNEL_IDENTITY_DEFAULTS: Readonly<Record<string, Partial<Record<string, ChannelIdentity>>>> = {
  feishu: {
    // Per-chat overrides go here. The 'default' key is the fallback for
    // any feishu group that doesn't have a per-chat entry. Specific groups
    // (like 'oc_xxxxx' = 毅之队) can override.
    default: {
      displayName: '咖啡猫',
      emoji: '🐱',
      exposeInternalNames: false,
    },
  },
};

export interface ChannelKey {
  readonly connectorId: string;
  readonly externalChatId: string;
}

const channelKeyEq = (a: ChannelKey, b: ChannelKey): boolean =>
  a.connectorId === b.connectorId && a.externalChatId === b.externalChatId;

/** In-memory registry; Phase 1 path. Phase 3 may swap to Redis-backed. */
export class ChannelIdentityRegistry {
  private readonly explicit = new Map<string, ChannelIdentity>();

  /**
   * Register an explicit identity for a (connector, chat) pair.
   * Wins over the default fallback.
   */
  set(connectorId: string, externalChatId: string, identity: ChannelIdentity): void {
    this.explicit.set(`${connectorId}:${externalChatId}`, identity);
  }

  unset(connectorId: string, externalChatId: string): boolean {
    return this.explicit.delete(`${connectorId}:${externalChatId}`);
  }

  /**
   * Resolve the identity for an outbound (connector, chat) target.
   * Order: explicit registration → connector default → undefined (no override).
   */
  resolve(connectorId: string, externalChatId: string): ChannelIdentity | undefined {
    const explicit = this.explicit.get(`${connectorId}:${externalChatId}`);
    if (explicit) return explicit;
    const fallback = CHANNEL_IDENTITY_DEFAULTS[connectorId]?.default;
    return fallback;
  }

  /**
   * F267 KD-2: DM behavior preservation.
   * The caller can hint whether this is a DM (chatType === 'p2p') —
   * DMs do NOT inherit the connector default, only explicit registrations.
   */
  resolveForChatType(
    connectorId: string,
    externalChatId: string,
    chatType: 'p2p' | 'group' | undefined,
  ): ChannelIdentity | undefined {
    if (chatType === 'p2p') {
      // DMs only honor explicit registrations — keep cat's natural displayName.
      return this.explicit.get(`${connectorId}:${externalChatId}`);
    }
    return this.resolve(connectorId, externalChatId);
  }

  list(): Array<{ key: ChannelKey; identity: ChannelIdentity }> {
    const out: Array<{ key: ChannelKey; identity: ChannelIdentity }> = [];
    for (const [k, identity] of this.explicit) {
      const [connectorId, externalChatId] = k.split(':', 2);
      out.push({ key: { connectorId, externalChatId }, identity });
    }
    return out;
  }
}

export { channelKeyEq };
