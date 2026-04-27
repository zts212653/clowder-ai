import type { RecentArtifact } from './artifact-tracking.js';

export interface ThreadMeta {
  canonicalFeatureId?: string;
  threadTitle?: string;
}

export interface RankedSource {
  type: RecentArtifact['type'];
  ref: string;
  label: string;
  provenance: 'canonical' | 'regex' | 'recency';
}

interface ActiveTask {
  kind: string;
  subjectKey: string | null;
  title: string;
  status: string;
}

const FEATURE_ID_REGEX = /[Ff](\d{2,4})/;

function normalizeFeatureId(raw: string): string {
  const m = /^[Ff](\d+)$/.exec(raw);
  if (!m) return raw;
  return `F${m[1].replace(/^0+/, '')}`;
}

function extractFeatureIdFromRef(ref: string): string | undefined {
  const raw = FEATURE_ID_REGEX.exec(ref)?.[0];
  return raw ? normalizeFeatureId(raw) : undefined;
}

function extractFeatureIdFromText(text: string): string | undefined {
  const raw = FEATURE_ID_REGEX.exec(text)?.[0];
  return raw ? normalizeFeatureId(raw) : undefined;
}

export function rankArtifactSources(
  ledger: readonly RecentArtifact[],
  activeTasks: readonly ActiveTask[],
  threadMeta: ThreadMeta,
): RankedSource[] {
  if (ledger.length === 0) return [];

  const featureId = threadMeta.canonicalFeatureId;
  let regexFeatureId = featureId ? undefined : extractFeatureIdFromText(threadMeta.threadTitle ?? '');
  if (!featureId && !regexFeatureId) {
    for (const t of activeTasks) {
      if (t.status === 'done') continue;
      const found = extractFeatureIdFromText(t.title);
      if (found) {
        regexFeatureId = found;
        break;
      }
    }
  }
  const matchedFeatureId = featureId ? normalizeFeatureId(featureId) : regexFeatureId;
  const provenance: 'canonical' | 'regex' | 'recency' = featureId ? 'canonical' : regexFeatureId ? 'regex' : 'recency';

  const activePrRefs = new Set(
    activeTasks
      .filter((t) => t.kind === 'pr_tracking' && t.status !== 'done' && t.subjectKey)
      .map((t) => t.subjectKey!.replace(/^pr:/, '')),
  );

  const tier1: RankedSource[] = [];
  const tier2: RankedSource[] = [];
  const tier3: { source: RankedSource; updatedAt: number }[] = [];

  for (const a of ledger) {
    const entry: RankedSource = { type: a.type, ref: a.ref, label: a.label, provenance };

    if (matchedFeatureId && a.type === 'feature-doc' && extractFeatureIdFromRef(a.ref) === matchedFeatureId) {
      tier1.push(entry);
    } else if (a.type === 'pr' && activePrRefs.has(a.ref)) {
      tier2.push(entry);
    } else {
      entry.provenance = 'recency';
      tier3.push({ source: entry, updatedAt: a.updatedAt });
    }
  }

  tier3.sort((a, b) => b.updatedAt - a.updatedAt);
  return [...tier1, ...tier2, ...tier3.map((t) => t.source)];
}
