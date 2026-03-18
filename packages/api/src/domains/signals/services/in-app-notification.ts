import type { SignalArticle } from '@cat-cafe/shared';
import type { SignalNotificationConfig } from '../config/notifications-loader.js';

export interface InAppPublishEvent {
  readonly threadId: string;
  readonly content: string;
}

export interface InAppNotificationSink {
  publish(event: InAppPublishEvent): Promise<void>;
}

export interface PublishDailyDigestInput {
  readonly date: string;
  readonly articles: readonly SignalArticle[];
}

export interface InAppNotificationResult {
  readonly status: 'sent' | 'skipped' | 'error';
  readonly error?: string | undefined;
}

export interface SignalInAppNotificationServiceOptions {
  readonly config: SignalNotificationConfig;
  readonly sink: InAppNotificationSink;
}

function toDigestContent(input: PublishDailyDigestInput): string {
  if (input.articles.length === 0) {
    return `🐱 Clowder AI 信号日报（${input.date}）\n\n今日无新增信号，咱们继续观察。`;
  }

  const lines = [`🐱 Clowder AI 信号日报（${input.date}）`, '', `新增 ${input.articles.length} 条信号：`, ''];

  const sorted = [...input.articles].sort((a, b) => {
    if (a.tier === b.tier) {
      if (a.source === b.source) return a.title.localeCompare(b.title);
      return a.source.localeCompare(b.source);
    }
    return a.tier - b.tier;
  });

  for (const article of sorted) {
    lines.push(`- [T${article.tier}] ${article.title} (${article.source})`);
    lines.push(`  ${article.url}`);
  }

  return lines.join('\n');
}

export class SignalInAppNotificationService {
  private readonly config: SignalNotificationConfig;
  private readonly sink: InAppNotificationSink;

  constructor(options: SignalInAppNotificationServiceOptions) {
    this.config = options.config;
    this.sink = options.sink;
  }

  async publishDailyDigest(input: PublishDailyDigestInput): Promise<InAppNotificationResult> {
    const inAppConfig = this.config.notifications.in_app;

    if (!inAppConfig.enabled) {
      return { status: 'skipped' };
    }

    try {
      await this.sink.publish({
        threadId: inAppConfig.thread,
        content: toDigestContent(input),
      });
      return { status: 'sent' };
    } catch (error) {
      return {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
