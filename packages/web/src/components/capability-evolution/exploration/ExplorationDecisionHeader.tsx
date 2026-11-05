import { refIdentity } from '@cat-cafe/shared';
import { EvolutionSource } from '../EvolutionVersionEvidence';
import type { useExplorationWorkspace } from './use-exploration-workspace';

export function ExplorationDecisionHeader({
  workspace,
  v2 = false,
}: {
  workspace: ReturnType<typeof useExplorationWorkspace>;
  v2?: boolean;
}) {
  const { node, catalog, experiments, experiment, reading, change, selectedExperimentKey } = workspace;
  if (!node || !catalog) return null;
  const incomplete = experiments.filter((run) => run.status !== 'recorded' || !run.recordCount);
  return (
    <header className="exploration-decision-header">
      <h2>{node.title}</h2>
      <p className="exploration-version-summary">{node.summary}</p>
      {v2 && (
        <section aria-label="整体方案与版本来源" className="exploration-version-changes">
          <h3>整体方案 · 这一版改了什么</h3>
          <EvolutionSource label="版本原件与出处" source={node.sourceRef} />
          {node.changes.map((item, index) => (
            <div key={`${item.label}:${index}`}>
              <h4>{item.label}</h4>
              <p>{item.detail}</p>
              <EvolutionSource label="依据" source={item.sourceRef} href={item.ownerHref} />
            </div>
          ))}
          {!node.changes.length && <p>来源未登记成员变化，不能推断哪些成员改变或保持不变。</p>}
        </section>
      )}
      <details className="exploration-run-picker" open={v2 || undefined}>
        <summary>
          <span>{experiment?.title ?? '尚未测量'}</span>
          <span>对照 {workspace.compareExperiment?.title ?? '未选择'}</span>
          <em>更换实验 · {experiments.length} 次</em>
        </summary>
        <div className="exploration-run-controls">
          <label>
            本版实验
            <select
              aria-label="选择本版实验"
              value={selectedExperimentKey ?? ''}
              onChange={(event) => {
                change({
                  selectedExperimentRef: experiments.find(
                    (run) => refIdentity(run.experimentRef) === event.target.value,
                  )?.experimentRef,
                  comparisonExperimentRef: undefined,
                  comparisonChoice: 'auto',
                  selectedCaseId: undefined,
                  caseFilter: 'all',
                  comparisonScope: 'full',
                  comparisonScopeKey: undefined,
                });
                const picker = event.currentTarget.closest('details');
                if (picker) picker.open = false;
              }}
            >
              <option value="" disabled>
                {experiments.length ? '选择实验' : '尚未测量'}
              </option>
              {experiments.map((run) => (
                <option key={refIdentity(run.experimentRef)} value={refIdentity(run.experimentRef)}>
                  {run.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            对照实验
            <select
              aria-label="选择对照实验"
              value={reading.comparisonExperimentRef ? refIdentity(reading.comparisonExperimentRef) : ''}
              onChange={(event) => {
                change({
                  comparisonExperimentRef: catalog.experiments.find(
                    (run) => refIdentity(run.experimentRef) === event.target.value,
                  )?.experimentRef,
                  comparisonChoice: 'manual',
                  selectedCaseId: undefined,
                  caseFilter: 'all',
                  comparisonScope: 'full',
                  comparisonScopeKey: undefined,
                });
                const picker = event.currentTarget.closest('details');
                if (picker) picker.open = false;
              }}
            >
              <option value="">暂不比较</option>
              {catalog.experiments
                .filter((run) => refIdentity(run.experimentRef) !== selectedExperimentKey)
                .map((run) => (
                  <option key={refIdentity(run.experimentRef)} value={refIdentity(run.experimentRef)}>
                    {run.title}
                  </option>
                ))}
            </select>
          </label>
        </div>
        {experiment && (
          <p className="exploration-condition-line">
            {experiment.conditions.sampleSet.label} · {experiment.conditions.measurement.label}
            {reading.comparisonChoice === 'auto' && reading.comparisonExperimentRef && (
              <span> · 建议对照：条件匹配的父版本实验，可更换</span>
            )}
          </p>
        )}
      </details>
      {incomplete.length > 0 && (
        <details className="exploration-run-notice">
          <summary>{incomplete.length} 次未完成或暂无记录的运行 · 查看</summary>
          {incomplete.map((run) => (
            <button
              type="button"
              key={refIdentity(run.experimentRef)}
              onClick={(event) => {
                change({
                  selectedExperimentRef: run.experimentRef,
                  comparisonExperimentRef: undefined,
                  comparisonChoice: 'auto',
                  selectedCaseId: undefined,
                  caseFilter: 'all',
                  comparisonScope: 'full',
                  comparisonScopeKey: undefined,
                });
                const notice = event.currentTarget.closest('details');
                if (notice) notice.open = false;
              }}
            >
              {run.title}
            </button>
          ))}
        </details>
      )}
    </header>
  );
}
