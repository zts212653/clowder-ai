'use client';

import {
  buildConciergeDraftPrompt,
  type CapabilityTip,
  type CapabilityTipAudience,
  type CapabilityTipContext,
  type CapabilityTipSurface,
  selectCapabilityTip,
  type TipExposureState,
  validateCapabilityTipInventory,
} from '@cat-cafe/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import rawTips from '@/lib/capability-tips.seed.json';
import { recordCapabilityTipEvent } from '@/lib/capabilityTipEvents';
import {
  computeExposureScope,
  isRoundComplete,
  loadExposureState,
  markTipExposed,
  resetExposureScope,
} from '@/lib/capabilityTipExposure';
import { useConciergeStore } from '@/stores/conciergeStore';

const parsedInventory = validateCapabilityTipInventory(rawTips);
if (!parsedInventory.success) {
  throw new Error(`Invalid F244 capability tips inventory:\n${parsedInventory.errors.join('\n')}`);
}

const CAPABILITY_TIPS: readonly CapabilityTip[] = parsedInventory.tips ?? [];
const DEFAULT_FIRST_DELAY_MS = 6000;
const DEFAULT_ROTATE_MS = 30000;

const INVENTORY_TIP_IDS: readonly string[] = CAPABILITY_TIPS.map((t) => t.id);

function canRenderInTipStrip(tip: CapabilityTip): boolean {
  return tip.action?.type === 'open_concierge_draft';
}

const CAPABILITY_TIP_STRIP_TIPS: readonly CapabilityTip[] = CAPABILITY_TIPS.filter(canRenderInTipStrip);

/** Inner content rendered once the tip is ready — extracted to keep type narrowing clean. */
function TipContent({
  tip,
  matchedContext,
  surface,
  setSurfaceState,
}: {
  tip: CapabilityTip;
  matchedContext: CapabilityTipContext;
  surface: CapabilityTipSurface;
  setSurfaceState: (state: 'collapsed' | 'toolbar' | 'bubble', prompt?: string) => void;
}) {
  const openDraft = () => {
    setSurfaceState('bubble', buildConciergeDraftPrompt(tip));
    recordCapabilityTipEvent({
      event: 'capability_tip_action',
      tipId: tip.id,
      context: matchedContext,
      surface,
      actionType: 'open_concierge_draft',
      outcome: 'opened',
      timestamp: Date.now(),
    });
  };

  return (
    <>
      <span className="shrink-0 font-medium text-cafe-secondary">Tip</span>
      <span className="min-w-0 flex-1 break-words">{tip.body}</span>
      <button
        type="button"
        data-testid="capability-tip-learn-more"
        onClick={openDraft}
        title="了解更多：打开猫猫球并预填输入框，不会自动发送"
        className="shrink-0 rounded-md border border-cafe px-2 py-1 text-xs font-medium text-cafe-secondary transition-colors hover:border-cafe-accent hover:text-cafe-accent"
      >
        了解更多
      </button>
    </>
  );
}

interface CapabilityTipStripProps {
  surface: CapabilityTipSurface;
  contexts: readonly CapabilityTipContext[];
  audience?: CapabilityTipAudience;
  enabled?: boolean;
  firstDelayMs?: number;
  rotateMs?: number;
}

export function CapabilityTipStrip({
  surface,
  contexts,
  audience,
  enabled = true,
  firstDelayMs = DEFAULT_FIRST_DELAY_MS,
  rotateMs = DEFAULT_ROTATE_MS,
}: CapabilityTipStripProps) {
  const [contentReady, setContentReady] = useState(firstDelayMs <= 0);
  const [rotationKey, setRotationKey] = useState(0);
  const exposedKeyRef = useRef<string | null>(null);
  const setSurfaceState = useConciergeStore((s) => s.setSurfaceState);

  // ── F244 Phase D: exposure-uniform selection (#997) ──────────────────────
  const scope = useMemo(() => computeExposureScope(surface, audience, contexts), [surface, audience, contexts]);
  // Ref-based exposure state: avoids re-render cascade from marking tips exposed.
  // (exposure mark → setState → different tip selected → mark again → ∞ loop)
  // The ref is read during tip selection (useMemo) which only recalculates on
  // rotationKey / prop changes — not on exposure state mutations.
  const exposureStateRef = useRef<TipExposureState>(loadExposureState(scope, INVENTORY_TIP_IDS, Date.now()));
  // Synchronous scope sync: must happen during render (before tip useMemo reads
  // the ref) so scope changes are reflected immediately — useEffect would fire
  // AFTER render, leaving one render with stale exposure from the old scope (P1).
  const prevScopeRef = useRef(scope);
  if (prevScopeRef.current !== scope) {
    exposureStateRef.current = loadExposureState(scope, INVENTORY_TIP_IDS, Date.now());
    prevScopeRef.current = scope;
  }

  useEffect(() => {
    setContentReady(firstDelayMs <= 0);
    setRotationKey(0);
    exposedKeyRef.current = null;
    if (!enabled || contexts.length === 0) return;
    if (firstDelayMs <= 0) return; // already ready

    const showTimer = setTimeout(() => setContentReady(true), firstDelayMs);

    return () => {
      clearTimeout(showTimer);
    };
  }, [enabled, contexts, firstDelayMs]);

  useEffect(() => {
    if (!enabled || !contentReady || contexts.length === 0) return;

    const rotationTimer = setInterval(
      () => {
        setRotationKey((value) => value + 1);
      },
      Math.max(DEFAULT_ROTATE_MS, rotateMs),
    );

    return () => {
      clearInterval(rotationTimer);
    };
  }, [enabled, contentReady, contexts, rotateMs]);

  const tip = useMemo(() => {
    // dateSeed computed inline (not memoized) so long-lived tabs reshuffle after midnight
    const d = new Date();
    const dateSeed = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return selectCapabilityTip(CAPABILITY_TIP_STRIP_TIPS, {
      contexts,
      audience,
      rotationKey,
      exposure: exposureStateRef.current,
      dateSeed,
      scopeKey: scope,
    });
    // exposureState intentionally excluded — read via ref to avoid re-render cascade.
    // scope included: ensures immediate re-selection on scope change (P1 fix).
  }, [audience, contexts, rotationKey, scope]);
  const matchedContext = useMemo(
    () => (tip ? contexts.find((context) => tip.contexts.includes(context)) : undefined),
    [contexts, tip],
  );

  // Mark displayed tips as exposed → localStorage + round-complete reset.
  // Updates the ref (not state) to avoid triggering re-render → re-select → cascade.
  const handleExposure = useCallback(
    (shownTip: CapabilityTip, ctx: CapabilityTipContext) => {
      recordCapabilityTipEvent({
        event: 'capability_tip_exposed',
        tipId: shownTip.id,
        context: ctx,
        surface,
        outcome: 'shown',
        timestamp: Date.now(),
      });
      const updated = markTipExposed(scope, exposureStateRef.current, shownTip.id);
      // All eligible shown? → reset scope for a fresh round
      const eligibleIds = CAPABILITY_TIP_STRIP_TIPS.filter((t) => {
        const matchesAud = audience === undefined || t.audience.includes('all') || t.audience.includes(audience);
        return matchesAud && t.contexts.some((c) => contexts.includes(c));
      }).map((t) => t.id);
      if (isRoundComplete(updated, eligibleIds)) {
        exposureStateRef.current = resetExposureScope(scope, updated);
      } else {
        exposureStateRef.current = updated;
      }
    },
    [scope, surface, audience, contexts],
  );

  useEffect(() => {
    if (!enabled || !contentReady || !tip || !matchedContext) return;
    const exposureKey = `${surface}:${tip.id}:${rotationKey}`;
    if (exposedKeyRef.current === exposureKey) return;
    exposedKeyRef.current = exposureKey;
    handleExposure(tip, matchedContext);
  }, [matchedContext, rotationKey, surface, tip, contentReady, handleExposure]);

  if (!enabled) return null;

  const showContent = contentReady && tip && matchedContext;

  return (
    <div
      data-testid="capability-tip-strip"
      data-tip-id={showContent ? tip.id : undefined}
      className="tip-thinking mt-1 flex min-h-8 w-full max-w-full items-start gap-2 rounded-md border border-cafe bg-cafe-surface-elevated/70 px-2.5 py-2 text-xs leading-5 text-cafe-muted"
      role="status"
    >
      {showContent ? (
        <TipContent tip={tip} matchedContext={matchedContext} surface={surface} setSurfaceState={setSurfaceState} />
      ) : (
        <>
          <span className="sr-only">猫猫思考中</span>
          <div className="flex w-full items-center gap-2 animate-pulse" aria-hidden="true">
            <span className="h-3 w-6 rounded bg-cafe-muted/20" />
            <span className="h-3 flex-1 rounded bg-cafe-muted/15" />
          </div>
        </>
      )}
    </div>
  );
}
