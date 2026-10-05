import type { ArtifactReviewView } from '@cat-cafe/shared';

export const reviewAuthorityMessages: Record<ArtifactReviewView['authority']['state'], string> = {
  current: '',
  task_changed: '原任务已有变化，请负责的猫核对后继续；讨论与草稿保留。',
  task_closed: '原任务已收口，讨论与历史版本继续保留。',
  asset_changed: '媒体已有新变化，请刷新并核对当前版本后继续。',
};
