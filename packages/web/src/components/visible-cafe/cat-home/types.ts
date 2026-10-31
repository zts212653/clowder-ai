import type { CatLifeSettingsInput } from '@cat-cafe/shared';

export interface CatLifeConfigView {
  catId: string;
  enabled: boolean;
  rhythm: CatLifeSettingsInput['rhythm'];
  wakeTime: string;
  timezone: string;
  quietHours?: CatLifeSettingsInput['quietHours'];
  nextWakeAt: number | null;
  weeklyWakeCount: number;
  costBand: 'low' | 'medium' | 'high';
  costNotice: string;
  projectionStatus: 'pending' | 'ready' | 'error';
  projectionError?: string;
  revision: number;
}

export interface CatLifeSettingsResponse {
  catId: string;
  config: CatLifeConfigView | null;
  defaults: CatLifeSettingsInput;
}

export interface CatLifePreviewView {
  previewId: string;
  catId: string;
  settings: CatLifeSettingsInput;
  nextWakeAt: number | null;
  weeklyWakeCount: number;
  costBand: 'low' | 'medium' | 'high';
  costNotice: string;
  expiresAt: number;
}

export interface DiaryEngagementView {
  opened: boolean;
  reacted: boolean;
  openCount: number;
}

export interface DiaryPageView {
  diaryId: string;
  catId: string;
  localDate: string;
  headline: string;
  summary: string;
  engagement: DiaryEngagementView;
}

export interface DiaryListResponse {
  diaries: DiaryPageView[];
  engagementMetrics: {
    publishedDiaryCount: number;
    openedDiaryCount: number;
    reactedDiaryCount: number;
  } | null;
}

export interface DiaryDetailResponse {
  diary: DiaryPageView & { bodyMarkdown: string };
  historicalNotice: string;
}
