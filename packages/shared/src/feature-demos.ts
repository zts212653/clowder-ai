/** Fixed published cuts, packaged from site/assets/demos by sync-vendor-assets. */
export const FEATURE_DEMOS = {
  'conversation-proposals-v1': {
    tipId: 'capability-propose-thread',
    assetSource: 'site/assets/demos/conversation-proposals.zh.mp4',
    posterAssetSource: 'site/assets/demos/conversation-proposals.jpg',
    sha256: '373931deec39bdedcaa0a769c92fe1e99a7686ce48f84c5c37ae1208036593b6',
    title: '新对话提议',
    src: '/vendor/demos/conversation-proposals-v1.zh.mp4',
    poster: '/vendor/demos/conversation-proposals-v1.jpg',
    durationSeconds: 48.5,
    tryPrompt: '请帮我把当前这件事拆成几条可以独立推进的工作线，提议创建新对话，填好提议卡让我确认。先不要直接创建。',
  },
} as const;

export type FeatureDemoId = keyof typeof FEATURE_DEMOS;

export function getFeatureDemo(id: string | undefined) {
  return id && Object.hasOwn(FEATURE_DEMOS, id) ? FEATURE_DEMOS[id as FeatureDemoId] : undefined;
}
