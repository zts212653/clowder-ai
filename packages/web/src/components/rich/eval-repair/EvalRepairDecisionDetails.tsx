import { type ApprovalHubItem, evalRepairDecisionExplanationV1Schema } from '@cat-cafe/shared';
import { MarkdownContent } from '@/components/MarkdownContent';
import { useShellCopy } from '@/components/shell/shell-copy';
import { evalRepairCopy } from '../eval-repair.shell-copy';
import type { evalRepairModel } from '../eval-repair-model';

type RepairModel = NonNullable<ReturnType<typeof evalRepairModel>>;

function readExplanation(detail: Record<string, unknown>) {
  const nested = evalRepairDecisionExplanationV1Schema.safeParse(detail.decisionExplanation);
  if (nested.success) return nested.data;
  const flat = evalRepairDecisionExplanationV1Schema.safeParse({
    schemaVersion: 1,
    expectedChange: detail.expectedChange,
    beforeSummary: detail.beforeSummary,
    afterSummary: detail.afterSummary,
    changeSetSummary: detail.changeSetSummary,
    attributionBoundary: detail.attributionBoundary,
    independentVerification: detail.independentVerification,
    rejectedCandidates: detail.rejectedCandidates,
    costAndRollback: detail.costAndRollback,
  });
  return flat.success ? flat.data : null;
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="font-medium">{label}</dt>
      <dd className="m-0 whitespace-pre-wrap break-words">{value}</dd>
    </div>
  );
}

/** The producer-owned decision boundary shown by the F266 card itself, in Chat and every host. */
export function EvalRepairDecisionDetails({ item, model }: { item: ApprovalHubItem; model: RepairModel }) {
  const t = useShellCopy(evalRepairCopy);
  const explanation = readExplanation(item.detail);
  return (
    <div className="space-y-3" data-testid="eval-repair-decision-explanation">
      <section>
        {explanation ? <p className="m-0 font-medium">{t.approvalScope}</p> : null}
        <h4 className="mb-1 font-medium">{t.change}</h4>
        <MarkdownContent content={explanation?.expectedChange ?? model.expectedChange} />
      </section>
      {explanation ? (
        <dl className="space-y-2">
          <Detail label={t.before} value={explanation.beforeSummary} />
          <Detail label={t.after} value={explanation.afterSummary} />
          <Detail label={t.changeSet} value={explanation.changeSetSummary} />
          <Detail label={t.attribution} value={explanation.attributionBoundary} />
          <Detail label={t.verification} value={explanation.independentVerification} />
          <div>
            <dt className="font-medium">{t.rejectedCandidates}</dt>
            <dd className="m-0">
              <ul className="m-0 list-disc pl-5">
                {explanation.rejectedCandidates.map((candidate) => (
                  <li key={candidate}>{candidate}</li>
                ))}
              </ul>
            </dd>
          </div>
        </dl>
      ) : null}
      <section>
        <h4 className="mb-1 font-medium">{t.cost}</h4>
        <p className="whitespace-pre-wrap break-words">{explanation?.costAndRollback ?? model.costAndRollback}</p>
      </section>
      <section>
        <h4 className="mb-1 font-medium">{t.withdraw}</h4>
        <p className="whitespace-pre-wrap break-words">{model.withdrawalCondition}</p>
      </section>
      <section>
        <h4 className="mb-1 font-medium">{t.target}</h4>
        <p className="break-words">{model.target.assetId}</p>
        <details>
          <summary className="shell-focusable cursor-pointer">{t.version}</summary>
          <p className="break-all">{model.target.version}</p>
        </details>
      </section>
    </div>
  );
}
