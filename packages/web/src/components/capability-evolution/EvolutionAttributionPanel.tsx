'use client';

/**
 * F311 Phase 3 — F307 Attribution panel (AC-34).
 *
 * Pure projection of the API-side attribution explanation: current evidence, competing
 * attributions, confidence bound, the layers nobody looked at, and why we are not changing
 * anything yet. It renders owner refs, never owner payload, and it holds no state of its own.
 */

export type EvolutionAttributionLayer = 'execution' | 'harness' | 'rubric' | 'observation';

export interface EvolutionAttributionExplanation {
  schemaVersion: 1;
  verdict: 'attributed' | 'unresolved' | 'insufficient' | 'incomparable';
  headline: string;
  primaryLayer?: { layer: EvolutionAttributionLayer; label: string };
  evidence: Array<{
    label: string;
    ownerFeatureId: string;
    ownerStateRef: string;
    version?: string;
    assetKind?: string;
    assetId?: string;
    /** Collision-free identity: rubric v3 and v4 are two entries, not one duplicated key. */
    identity: string;
  }>;
  competingAttributions: Array<{ layer: EvolutionAttributionLayer; label: string; discriminating: boolean }>;
  notAssessedLayers: Array<{ layer: EvolutionAttributionLayer; label: string }>;
  confidence: { basis: 'interval' | 'power' | 'not_estimable' | 'unknown'; label: string; ownerStateRef?: string };
  comparability: { status: 'comparable' | 'incomparable'; label: string };
  whyNotChange: string[];
  /**
   * Tri-state: an attribution with no gate evaluation yet is "pending", never "ready"; only a
   * canonical intervention_linked event opens Change Review.
   */
  gate: {
    status: 'pending' | 'blocked' | 'ready';
    blockers: Array<{ code: string; label: string; ownerFeatureId: string }>;
  };
}

const GATE_BADGES: Record<EvolutionAttributionExplanation['gate']['status'], string> = {
  pending: '干预门尚未评估',
  blocked: '暂不进入 Change Review',
  ready: '可以进入 Change Review',
};

const VERDICT_BADGES: Record<EvolutionAttributionExplanation['verdict'], string> = {
  attributed: '已确诊',
  unresolved: '未确诊',
  insufficient: '证据不足',
  incomparable: '不可比较',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-cafe-subtle bg-cafe-surface p-4">
      <h3 className="text-sm font-semibold text-cafe">{title}</h3>
      {children}
    </section>
  );
}

export function EvolutionAttributionPanel({ explanation }: { explanation: EvolutionAttributionExplanation | null }) {
  if (explanation === null) {
    return (
      <div className="space-y-4" data-testid="evolution-attribution-panel">
        <Section title="评估与归因">
          <p className="mt-2 text-xs leading-5 text-cafe-muted">
            这一轮还没有评估结果。触发器到点后，尺子和眼睛的结论会出现在这里。
          </p>
        </Section>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="evolution-attribution-panel">
      <Section title="这一轮看懂了什么">
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="rounded-full bg-cafe-hover px-3 py-1 text-cafe-secondary">
            {VERDICT_BADGES[explanation.verdict]}
          </span>
          <span className="rounded-full bg-cafe-hover px-3 py-1 text-cafe-secondary">
            {GATE_BADGES[explanation.gate.status]}
          </span>
        </div>
        <p className="mt-3 text-sm leading-6 text-cafe">{explanation.headline}</p>
        {explanation.primaryLayer && (
          <p className="mt-1 text-xs leading-5 text-cafe-secondary">最可能的一层：{explanation.primaryLayer.label}</p>
        )}
        <p className="mt-2 text-xs leading-5 text-cafe-muted">{explanation.confidence.label}</p>
        <p className="mt-1 text-xs leading-5 text-cafe-muted">{explanation.comparability.label}</p>
      </Section>

      <Section title="站在哪些证据上">
        <ul className="mt-2 space-y-2">
          {explanation.evidence.map((entry) => (
            <li key={entry.identity} className="rounded-lg bg-cafe-hover p-3">
              <p className="text-xs font-medium text-cafe-secondary">
                {entry.label}
                {entry.version && <span className="ml-2 text-cafe-muted">{entry.version}</span>}
                <span className="ml-2 text-cafe-muted">{entry.ownerFeatureId}</span>
              </p>
              <p className="mt-1 break-all font-mono text-xs text-cafe-muted">
                {entry.ownerStateRef}
                {entry.assetKind && entry.assetId ? ` · ${entry.assetKind}/${entry.assetId}` : ''}
              </p>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="竞争的解释">
        <ul className="mt-2 space-y-2">
          {explanation.competingAttributions.map((entry) => (
            <li key={entry.layer} className="rounded-lg bg-cafe-hover p-3" data-layer={entry.layer}>
              <p className="text-xs leading-5 text-cafe-secondary">{entry.label}</p>
              <p className="mt-1 text-xs text-cafe-muted">
                {entry.discriminating ? '证据能把这一层和其他层区分开' : '有证据，但不足以区分这一层'}
              </p>
            </li>
          ))}
        </ul>
        {explanation.notAssessedLayers.length > 0 && (
          <ul className="mt-3 space-y-1" data-testid="evolution-not-assessed">
            {explanation.notAssessedLayers.map((entry) => (
              <li key={entry.layer} className="text-xs leading-5 text-cafe-muted">
                {entry.label}
              </li>
            ))}
          </ul>
        )}
      </Section>

      {explanation.whyNotChange.length > 0 && (
        <Section title="为什么现在先不改">
          <ul className="mt-2 space-y-2" data-testid="evolution-why-not-change">
            {explanation.whyNotChange.map((line) => (
              <li key={line} className="text-xs leading-5 text-cafe-muted">
                {line}
              </li>
            ))}
          </ul>
          {explanation.gate.blockers.length > 0 && (
            <ul className="mt-3 space-y-2">
              {explanation.gate.blockers.map((blocker) => (
                <li key={blocker.code} className="rounded-lg bg-cafe-hover p-3" data-blocker-code={blocker.code}>
                  <p className="font-mono text-xs text-cafe-secondary">{blocker.code}</p>
                  <p className="mt-1 text-xs leading-5 text-cafe-muted">
                    {blocker.label}
                    <span className="ml-2 text-cafe-muted">{blocker.ownerFeatureId}</span>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Section>
      )}
    </div>
  );
}
