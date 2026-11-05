'use client';

type Transition = 'demo-open' | 'team-setup';
const KEY = 'cat-cafe:onboarding-navigation-timing:v1';

export function reportOnboardingTiming(kind: string, fields: Record<string, string | number>) {
  const value = { kind, ...fields };
  console.info('[onboarding-performance]', JSON.stringify(value));
  // Local inspection only: no prompts, identities, account values or outbound telemetry.
  document.documentElement.dataset.onboardingTiming = JSON.stringify(value);
}

export function beginOnboardingNavigation(action: Transition) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ action, at: Date.now() }));
  } catch {
    /* Timing is optional; it must never block navigation. */
  }
}

export function finishOnboardingNavigation(action: Transition, phase: 'mounted' | 'ready') {
  try {
    const pending: unknown = JSON.parse(sessionStorage.getItem(KEY) ?? 'null');
    if (!pending || typeof pending !== 'object' || !('action' in pending) || !('at' in pending)) return;
    if (pending.action !== action || typeof pending.at !== 'number') return;
    const durationMs = Date.now() - pending.at;
    if (durationMs < 0 || durationMs > 60_000) return;
    reportOnboardingTiming('navigation', { action, phase, durationMs, documentTimeOrigin: performance.timeOrigin });
    if (phase === 'ready') sessionStorage.removeItem(KEY);
  } catch {
    /* Old / unavailable browser storage is not a product error. */
  }
}

export function reportOnboardingPageLoad() {
  if (new URLSearchParams(window.location.search).get('diagnostics') !== 'onboarding') return;
  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
  const scripts = performance
    .getEntriesByType('resource')
    .filter((item) => (item as PerformanceResourceTiming).initiatorType === 'script') as PerformanceResourceTiming[];
  if (!navigation) return;
  const value = {
    navigationType: navigation.type,
    documentTimeOrigin: performance.timeOrigin,
    ttfbMs: Math.round(navigation.responseStart - navigation.requestStart),
    htmlMs: Math.round(navigation.responseEnd),
    hydratedMs: Math.round(performance.now()),
    scriptCount: scripts.length,
    decodedScriptBytes: scripts.reduce((sum, item) => sum + item.decodedBodySize, 0),
  };
  reportOnboardingTiming('page-load', value);
}
