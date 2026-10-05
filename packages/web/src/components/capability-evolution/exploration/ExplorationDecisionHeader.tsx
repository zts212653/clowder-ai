import { refIdentity } from '@cat-cafe/shared';
import type { useExplorationWorkspace } from './use-exploration-workspace';

export function ExplorationDecisionHeader({ workspace }: { workspace: ReturnType<typeof useExplorationWorkspace> }) {
  const { node, catalog, experiments, experiment, reading, change, selectedExperimentKey } = workspace;
  if (!node || !catalog) return null;
  const incomplete = experiments.filter((run) => run.status !== 'recorded' || !run.recordCount);
  return (
    <header className="exploration-decision-header">
      <h2>{node.title}</h2>
      <p className="exploration-version-summary">{node.summary}</p>
      <details className="exploration-run-picker">
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
