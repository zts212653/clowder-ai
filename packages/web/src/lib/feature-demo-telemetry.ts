import type { FeatureDemoSession } from '@/stores/featureDemoStore';
import { recordCapabilityTipEvent } from './capabilityTipEvents';

export type FeatureDemoStage = 'exposed' | 'opened' | 'started' | 'completed' | 'tried' | 'used';
const recorded = new WeakMap<FeatureDemoSession, Set<FeatureDemoStage>>();
const COMPLETED_KEY = 'cat-cafe:completed-feature-demo';
const OBSERVATION_WINDOW_MS = 7 * 86400000;

/** One observation per displayed tip, even if its player is closed/reopened. No person or content fields. */
export function recordFeatureDemoStage(session: FeatureDemoSession, stage: FeatureDemoStage): void {
  const stages = recorded.get(session) ?? new Set<FeatureDemoStage>();
  if (stages.has(stage)) return;
  const accepted = recordCapabilityTipEvent({
    event: `capability_tip_demo_${stage}`,
    tipId: session.tipId,
    context: session.context,
    surface: session.surface,
    outcome: stage === 'opened' || stage === 'tried' ? 'opened' : 'shown',
    timestamp: Date.now(),
  });
  if (!accepted) return;
  stages.add(stage);
  recorded.set(session, stages);
  if (stage === 'completed') {
    try {
      sessionStorage.setItem(COMPLETED_KEY, JSON.stringify({ ...session, completedAt: Date.now() }));
    } catch {
      /* No attribution when tab storage is unavailable; playback remains usable. */
    }
  }
}

/** F128-specific use definition: a newly created thread after its own demo. Other films need their own success producer. */
export function recordThreadProposalDemoUse(result: unknown): boolean {
  if (
    !result ||
    typeof result !== 'object' ||
    !('threadId' in result) ||
    typeof result.threadId !== 'string' ||
    !result.threadId.trim()
  )
    return false;
  if ('deduped' in result && result.deduped === true) return false;
  try {
    const raw = sessionStorage.getItem(COMPLETED_KEY);
    if (!raw) return false;
    const value = JSON.parse(raw) as FeatureDemoSession & { completedAt: number };
    if (value.demoId !== 'conversation-proposals-v1' || !Number.isFinite(value.completedAt)) return false;
    const age = Date.now() - value.completedAt;
    if (age < 0 || age > OBSERVATION_WINDOW_MS) {
      sessionStorage.removeItem(COMPLETED_KEY);
      return false;
    }
    const accepted = recordCapabilityTipEvent({
      event: 'capability_tip_demo_used',
      tipId: value.tipId,
      context: value.context,
      surface: value.surface,
      outcome: 'shown',
      timestamp: Date.now(),
    });
    if (accepted) sessionStorage.removeItem(COMPLETED_KEY);
    return accepted;
  } catch {
    return false;
  }
}
