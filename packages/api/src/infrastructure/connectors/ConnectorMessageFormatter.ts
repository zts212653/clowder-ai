/**
 * ConnectorMessageFormatter — Platform-agnostic message envelope generator.
 *
 * Converts cat reply metadata into a unified MessageEnvelope structure.
 * Each platform adapter then converts the envelope to its native format
 * (Feishu interactive card, Telegram MarkdownV2, Slack Block Kit, etc.).
 *
 * This is the public layer — business logic lives here, adapters only render.
 *
 * F088 Multi-Platform Chat Gateway
 */

export interface MessageEnvelope {
  /** Cat identity line, e.g. "🐱 布偶猫/宪宪" */
  readonly header: string;
  /** Thread context, e.g. "T12 飞书登录bug排查 · F088" */
  readonly subtitle: string;
  /** Message body (markdown supported) */
  readonly body: string;
  /** Deep link + timestamp, e.g. "📎 在前端查看 · 01:22" */
  readonly footer: string;
}

export interface FormatInput {
  readonly catDisplayName: string;
  readonly catEmoji: string;
  readonly threadShortId: string;
  readonly threadTitle?: string | undefined;
  readonly featId?: string | undefined;
  readonly body: string;
  readonly deepLinkUrl?: string | undefined;
  readonly timestamp: Date;
}

export class ConnectorMessageFormatter {
  format(input: FormatInput): MessageEnvelope {
    const header = `${input.catEmoji} ${input.catDisplayName}`;

    // Build subtitle: "T12 飞书登录bug排查 · F088"
    let subtitle = input.threadShortId;
    if (input.threadTitle) {
      subtitle += ` ${input.threadTitle}`;
    }
    if (input.featId) {
      subtitle += ` · ${input.featId}`;
    }

    // Build footer: "📎 在前端查看 · 01:22" or just "01:22"
    const timeStr = input.timestamp.toISOString().slice(11, 16); // HH:MM UTC
    let footer: string;
    if (input.deepLinkUrl) {
      footer = `📎 ${input.deepLinkUrl} · ${timeStr}`;
    } else {
      footer = timeStr;
    }

    return { header, subtitle, body: input.body, footer };
  }

  /**
   * Format a minimal envelope with cat identity only (no thread metadata).
   * Phase E: ensures every message is a distinct card even without threadMeta.
   */
  formatMinimal(input: { catDisplayName: string; catEmoji: string; body: string }): MessageEnvelope {
    return {
      header: `${input.catEmoji} ${input.catDisplayName}`,
      subtitle: '',
      body: input.body,
      footer: new Date().toISOString().slice(11, 16),
    };
  }

  /** Format a system/command response (no cat identity, lightweight envelope). */
  formatCommand(body: string): MessageEnvelope {
    return {
      header: 'Clowder AI',
      subtitle: '',
      body,
      footer: new Date().toISOString().slice(11, 16),
    };
  }
}
