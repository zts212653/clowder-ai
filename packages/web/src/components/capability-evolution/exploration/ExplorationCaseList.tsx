import { type EvolutionExplorationRecordV1, refIdentity } from '@cat-cafe/shared';
import { ExplorationIcon } from './ExplorationIcon';

export function ExplorationCaseList({
  records,
  selectedCaseId,
  onSelect,
}: {
  records: EvolutionExplorationRecordV1[];
  selectedCaseId?: string;
  onSelect(caseId: string): void;
}) {
  const satisfied = records.filter((record) => record.result.status === 'satisfied');
  const failures = records.filter((record) => record.result.status === 'violated');
  const unknown = records.filter((record) => record.result.status === 'unknown' || record.result.status === 'observed');
  const repeatCount = records.length - new Set(records.map((record) => refIdentity(record.evidenceRef))).size;
  const first = (entries: EvolutionExplorationRecordV1[]) => {
    const record = entries[0];
    if (record) onSelect(record.caseId);
  };
  return (
    <section className="exploration-case-list" aria-label="实验案例与覆盖">
      <h3 className="exploration-results-heading">
        <ExplorationIcon kind="diagnosis" />
        实验结果与反例
      </h3>
      <div className="exploration-counts">
        <button type="button" disabled={!satisfied.length} onClick={() => first(satisfied)}>
          <strong>{satisfied.length}</strong>
          <span>符合本次判据</span>
        </button>
        <button
          type="button"
          disabled={!failures.length}
          onClick={() => first(failures)}
          className="exploration-failure-count"
        >
          <strong>{failures.length}</strong>
          <span>失败 / 反例</span>
        </button>
        <button type="button" disabled={!unknown.length} onClick={() => first(unknown)}>
          <strong>{unknown.length}</strong>
          <span>尚待判断</span>
        </button>
      </div>
      <p className="exploration-caption">
        {records.length} 条记录{repeatCount > 0 ? `，其中 ${repeatCount} 条为相同 capture 的重复记录` : ''}
        ；这些是记录计数，不是独立样本数。按来源场景顺序展示，点击数字或案例查看原始结果。
      </p>
      {failures.length > 0 && (
        <p className="exploration-failure-summary">
          <ExplorationIcon kind="warning" />
          失败与反例：
          {failures.map((record) => (
            <button type="button" key={record.caseId} onClick={() => onSelect(record.caseId)}>
              {record.label}
            </button>
          ))}
        </p>
      )}
      <details className="exploration-all-cases">
        <summary>查看全部 {records.length} 条案例与判定</summary>
        <div className="exploration-cases" role="list" aria-label="全部案例">
          {records.map((record) => (
            <div role="listitem" key={refIdentity(record.recordRef)}>
              <button
                type="button"
                aria-pressed={selectedCaseId === record.caseId}
                onClick={() => onSelect(record.caseId)}
                data-case-id={record.caseId}
                data-result={record.result.status}
              >
                <ExplorationIcon
                  kind={
                    record.result.status === 'satisfied'
                      ? 'check'
                      : record.result.status === 'violated'
                        ? 'warning'
                        : 'experiment'
                  }
                />
                <span>
                  <strong>{record.label}</strong>
                  <span>{record.result.label}</span>
                </span>
              </button>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
