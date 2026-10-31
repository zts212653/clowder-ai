import catalogue from './feature-demos.json' with { type: 'json' };

/**
 * F331: the only place a film is attached to a tip. Add a cut to site/assets/demos, add one entry to
 * feature-demos.json, then run `pnpm demos:pin` to fill in its duration and sha256.
 */
export interface FeatureDemoEntry {
  tipId: string;
  title: string;
  /** File name under site/assets/demos. */
  video: string;
  /** File name under site/assets/demos. */
  poster: string;
  tryPrompt: string;
  /** Set only where the product records a real "used it after watching" signal. */
  useSignal?: 'f128-proposal-created';
  durationSeconds?: number;
  sha256?: string;
}

export const FEATURE_DEMO_ASSET_DIR = 'site/assets/demos';

/** Published URLs stay keyed by demo id so a later cut can ship under a new id. */
function publish(id: string, entry: FeatureDemoEntry) {
  return {
    tipId: entry.tipId,
    title: entry.title,
    tryPrompt: entry.tryPrompt,
    useSignal: entry.useSignal,
    durationSeconds: entry.durationSeconds ?? 0,
    sha256: entry.sha256 ?? '',
    assetSource: `${FEATURE_DEMO_ASSET_DIR}/${entry.video}`,
    posterAssetSource: `${FEATURE_DEMO_ASSET_DIR}/${entry.poster}`,
    src: `/vendor/demos/${id}${entry.video.slice(entry.video.indexOf('.'))}`,
    poster: `/vendor/demos/${id}${entry.poster.slice(entry.poster.lastIndexOf('.'))}`,
  };
}

export type FeatureDemo = ReturnType<typeof publish>;
export type FeatureDemoId = string;

export const FEATURE_DEMOS: Readonly<Record<FeatureDemoId, FeatureDemo>> = Object.fromEntries(
  Object.entries(catalogue as Record<string, FeatureDemoEntry>).map(([id, entry]) => [id, publish(id, entry)]),
);

const DEMO_BY_TIP = new Map(Object.entries(FEATURE_DEMOS).map(([id, demo]) => [demo.tipId, id]));

export function getFeatureDemo(id: string | undefined) {
  return id && Object.hasOwn(FEATURE_DEMOS, id) ? FEATURE_DEMOS[id] : undefined;
}

export function getFeatureDemoIdForTip(tipId: string | undefined) {
  return tipId ? DEMO_BY_TIP.get(tipId) : undefined;
}
