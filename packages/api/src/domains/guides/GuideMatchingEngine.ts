import type { IGuideDismissTracker } from './GuideDismissTracker.js';

export interface MatchedGuideCandidate {
  id: string;
  name: string;
  estimatedTime: string;
  status: 'offered';
  isNewOffer: true;
}

export interface MatchedGuideOffer {
  candidate: MatchedGuideCandidate;
  confidence: number;
}

/**
 * B-6: Detect explicit guide trigger from message.
 * `/guide <name>` or `引导 <name>` are explicit commands that bypass
 * confidence thresholds and dismiss suppression.
 */
const EXPLICIT_GUIDE_RE = /^(?:\/guide\b|引导(?=\s|$))/i;

export function isExplicitGuideRequest(message: string): boolean {
  return EXPLICIT_GUIDE_RE.test(message.trim());
}

/** Strip explicit command prefix so keyword matching sees the intent. */
export function stripExplicitPrefix(message: string): string {
  return message.trim().replace(EXPLICIT_GUIDE_RE, '').trim();
}

/** Match raw user message against guide registry with B-6 offer policy. */
export async function matchGuideOfferCandidate(params: {
  message: string;
  userId: string;
  dismissTracker?: IGuideDismissTracker;
}): Promise<MatchedGuideOffer | undefined> {
  const { message, userId, dismissTracker } = params;
  try {
    const { resolveGuideForIntent, getTriggerStrategies, getRegistryEntries } = await import(
      './guide-registry-loader.js'
    );
    const { evaluateGuideOffer } = await import('./GuideOfferPolicy.js');

    const isExplicit = isExplicitGuideRequest(message);
    const intent = isExplicit ? stripExplicitPrefix(message) : message;
    if (!intent) return undefined;

    // B-6: Explicit triggers try direct ID/name match first, then keyword fallback.
    let matches = resolveGuideForIntent(intent);
    if (matches.length === 0 && isExplicit) {
      const normalized = intent.toLowerCase().replace(/[-_]/g, ' ').trim();
      const entry = getRegistryEntries().find(
        (candidate) =>
          candidate.id.toLowerCase() === intent.toLowerCase() || candidate.name.toLowerCase() === normalized,
      );
      if (entry) {
        matches = [
          {
            id: entry.id,
            name: entry.name,
            description: entry.description,
            estimatedTime: entry.estimated_time,
            score: entry.keywords.length,
            totalKeywords: entry.keywords.length,
          },
        ];
      }
    }
    if (matches.length === 0) return undefined;

    const guideIds = matches.map((candidate) => candidate.id);
    const dismissCounts = dismissTracker
      ? await dismissTracker.getDismissCounts(userId, guideIds).catch(() => ({}))
      : {};
    const triggerStrategies = getTriggerStrategies();

    const result = evaluateGuideOffer({
      candidates: matches.map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        score: candidate.score,
        totalKeywords: candidate.totalKeywords,
      })),
      triggerStrategies,
      userId,
      isExplicitTrigger: isExplicit,
      dismissCounts,
    });
    if (!result) return undefined;

    const top = matches.find((candidate) => candidate.id === result.id);
    if (!top) return undefined;
    return {
      candidate: {
        id: top.id,
        name: top.name,
        estimatedTime: top.estimatedTime,
        status: 'offered',
        isNewOffer: true,
      },
      confidence: result.confidence,
    };
  } catch {
    return undefined;
  }
}
