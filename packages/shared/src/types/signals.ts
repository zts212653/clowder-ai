/**
 * Signal Hunter domain types
 */

export type SignalTier = 1 | 2 | 3 | 4;

export type SignalCategory = 'official' | 'papers' | 'research' | 'engineering' | 'community' | 'other';

export type SignalFetchMethod = 'rss' | 'api' | 'webpage';

export type SignalScheduleFrequency = 'hourly' | 'daily' | 'weekly' | 'manual';

export interface SignalKeywordFilter {
  readonly include?: readonly string[] | undefined;
  readonly exclude?: readonly string[] | undefined;
}

export interface SignalSourceFetchConfig {
  readonly method: SignalFetchMethod;
  readonly selector?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly headers?: Record<string, string> | undefined;
}

export interface SignalSourceSchedule {
  readonly frequency: SignalScheduleFrequency;
}

export interface SignalSource {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly tier: SignalTier;
  readonly category: SignalCategory;
  readonly enabled: boolean;
  readonly fetch: SignalSourceFetchConfig;
  readonly schedule: SignalSourceSchedule;
  readonly filters?:
    | {
        readonly keywords?: SignalKeywordFilter | undefined;
        /** Keep only articles published within this many days; undated articles are kept. */
        readonly maxAgeDays?: number | undefined;
      }
    | undefined;
}

export interface SignalSourceConfig {
  readonly version: 1;
  readonly sources: readonly SignalSource[];
}

export type SignalArticleStatus = 'inbox' | 'read' | 'archived' | 'starred';

export interface SignalArticle {
  readonly id: string;
  readonly url: string;
  readonly title: string;
  readonly source: string;
  readonly tier: SignalTier;
  readonly publishedAt: string;
  readonly fetchedAt: string;
  readonly status: SignalArticleStatus;
  readonly tags: readonly string[];
  readonly summary?: string | undefined;
  readonly filePath: string;
  readonly note?: string | undefined;
  readonly deletedAt?: string | undefined;
  readonly studyCount?: number | undefined;
  readonly lastStudiedAt?: string | undefined;
}
