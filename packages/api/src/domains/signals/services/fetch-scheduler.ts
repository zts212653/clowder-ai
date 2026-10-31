import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SignalArticle, SignalSourceConfig } from '@cat-cafe/shared';
import type { SignalNotificationConfig } from '../config/notifications-loader.js';
import { loadSignalNotifications } from '../config/notifications-loader.js';
import type { SignalPaths } from '../config/signal-paths.js';
import { resolveSignalPaths } from '../config/signal-paths.js';
import { loadSignalSources } from '../config/sources-loader.js';
import { ApiFetcher } from '../fetchers/api-fetcher.js';
import { RssFetcher } from '../fetchers/rss-fetcher.js';
import type { FetchError, Fetcher } from '../fetchers/types.js';
import { WebpageFetcher } from '../fetchers/webpage-fetcher.js';
import { renderDailyDigestEmail } from '../templates/daily-digest.js';
import { ArticleStoreService } from './article-store.js';
import { DeduplicationService } from './deduplication.js';
import type { EmailSendResult } from './email-service.js';
import { SignalEmailService } from './email-service.js';
import type { InAppNotificationResult, InAppNotificationSink, PublishDailyDigestInput } from './in-app-notification.js';
import { SignalInAppNotificationService } from './in-app-notification.js';
import { loadKnownUrlsFromInbox } from './inbox-url-loader.js';
import type { ArticleStoreLike, DeduplicationLike } from './source-processor.js';
import { processSources, selectSources } from './source-processor.js';

interface EmailServiceLike {
  sendDailyDigest(message: { subject: string; html: string; text: string }): Promise<EmailSendResult>;
}

interface InAppServiceLike {
  publishDailyDigest(input: PublishDailyDigestInput): Promise<InAppNotificationResult>;
}

interface SchedulerServices {
  readonly deduplication: DeduplicationLike;
  readonly articleStore: ArticleStoreLike;
}

export interface SignalFetchSchedulerSummary {
  readonly dryRun: boolean;
  readonly fetchedAt: string;
  readonly processedSources: number;
  readonly skippedSources: number;
  readonly fetchedArticles: number;
  readonly newArticles: number;
  readonly storedArticles: number;
  readonly duplicateArticles: number;
  readonly errors: readonly FetchError[];
  readonly notifications?:
    | {
        readonly email: EmailSendResult;
        readonly inApp: InAppNotificationResult;
      }
    | undefined;
}

export interface SignalFetchSchedulerOptions {
  readonly sourceId?: string | undefined;
  readonly dryRun?: boolean | undefined;
  readonly paths?: SignalPaths | undefined;
  readonly now?: (() => Date) | undefined;
  readonly getGitHubApiToken?: (() => string | undefined) | undefined;
  readonly fetchers?: readonly Fetcher[] | undefined;
  readonly loadSources?: ((paths: SignalPaths) => Promise<SignalSourceConfig>) | undefined;
  readonly loadNotifications?: ((paths: SignalPaths) => Promise<SignalNotificationConfig>) | undefined;
  readonly loadKnownUrls?: ((paths: SignalPaths) => Promise<readonly string[]>) | undefined;
  readonly createDeduplicationService?: ((initialUrls: readonly string[]) => DeduplicationLike) | undefined;
  readonly articleStore?: ArticleStoreLike | undefined;
  readonly createEmailService?: ((config: SignalNotificationConfig) => EmailServiceLike) | undefined;
  readonly createInAppService?:
    | ((config: SignalNotificationConfig, paths: SignalPaths) => InAppServiceLike)
    | undefined;
}

function createDefaultInAppSink(paths: SignalPaths): InAppNotificationSink {
  const logPath = join(paths.logsDir, 'signals-in-app.log');

  return {
    async publish(event): Promise<void> {
      const payload = {
        threadId: event.threadId,
        content: event.content,
        createdAt: new Date().toISOString(),
      };
      await appendFile(logPath, `${JSON.stringify(payload)}\n`, 'utf-8');
    },
  };
}

function createDefaultFetchers(options: Pick<SignalFetchSchedulerOptions, 'getGitHubApiToken'>): readonly Fetcher[] {
  return [
    new RssFetcher(),
    new ApiFetcher(undefined, { getGitHubPat: options.getGitHubApiToken }),
    new WebpageFetcher(),
  ];
}

function resolveSchedulerServices(
  options: SignalFetchSchedulerOptions,
  initialKnownUrls: readonly string[],
  paths: SignalPaths,
): SchedulerServices {
  const deduplication = options.createDeduplicationService
    ? options.createDeduplicationService(initialKnownUrls)
    : new DeduplicationService(initialKnownUrls);
  const articleStore = options.articleStore ?? new ArticleStoreService({ paths });

  return {
    deduplication,
    articleStore,
  };
}

async function sendDigestNotifications(params: {
  options: SignalFetchSchedulerOptions;
  paths: SignalPaths;
  date: string;
  articles: readonly SignalArticle[];
  loadNotifications: (paths: SignalPaths) => Promise<SignalNotificationConfig>;
}): Promise<{ readonly email: EmailSendResult; readonly inApp: InAppNotificationResult }> {
  const notificationsConfig = await params.loadNotifications(params.paths);
  const emailService = params.options.createEmailService
    ? params.options.createEmailService(notificationsConfig)
    : new SignalEmailService({ config: notificationsConfig });
  const inAppService = params.options.createInAppService
    ? params.options.createInAppService(notificationsConfig, params.paths)
    : new SignalInAppNotificationService({
        config: notificationsConfig,
        sink: createDefaultInAppSink(params.paths),
      });
  const digest = renderDailyDigestEmail({ date: params.date, articles: params.articles });

  const [emailResult, inAppResult] = await Promise.all([
    emailService.sendDailyDigest(digest),
    inAppService.publishDailyDigest({ date: params.date, articles: params.articles }),
  ]);

  return {
    email: emailResult,
    inApp: inAppResult,
  };
}

export async function runSignalFetchScheduler(
  options: SignalFetchSchedulerOptions = {},
): Promise<SignalFetchSchedulerSummary> {
  const now = options.now ?? (() => new Date());
  const schedulerNow = now();
  const fetchedAt = schedulerNow.toISOString();
  const paths = options.paths ?? resolveSignalPaths();
  const dryRun = options.dryRun ?? false;
  const loadSources = options.loadSources ?? ((currentPaths) => loadSignalSources(currentPaths));
  const loadNotifications = options.loadNotifications ?? ((currentPaths) => loadSignalNotifications(currentPaths));
  const fetchers = options.fetchers ?? createDefaultFetchers(options);

  const sourceConfig = await loadSources(paths);
  const selectedSources = selectSources(sourceConfig, options.sourceId, schedulerNow);
  const initialKnownUrls = await (options.loadKnownUrls ?? loadKnownUrlsFromInbox)(paths);
  const services = resolveSchedulerServices(options, initialKnownUrls, paths);
  const sourceResults = await processSources({
    sources: selectedSources,
    fetchers,
    dryRun,
    deduplication: services.deduplication,
    articleStore: services.articleStore,
  });

  const summaryBase = {
    dryRun,
    fetchedAt,
    processedSources: selectedSources.length,
    skippedSources: sourceConfig.sources.length - selectedSources.length,
    fetchedArticles: sourceResults.fetchedArticles,
    newArticles: sourceResults.fetchedArticles - sourceResults.duplicateArticles,
    storedArticles: sourceResults.storedArticles.length,
    duplicateArticles: sourceResults.duplicateArticles,
    errors: sourceResults.errors,
  };

  if (dryRun || selectedSources.length === 0) {
    return {
      ...summaryBase,
      storedArticles: 0,
    };
  }

  if (sourceResults.errors.length > 0) {
    return summaryBase;
  }

  const notifications = await sendDigestNotifications({
    options,
    paths,
    date: fetchedAt.slice(0, 10),
    articles: sourceResults.storedArticles,
    loadNotifications,
  });

  return {
    ...summaryBase,
    notifications,
  };
}
