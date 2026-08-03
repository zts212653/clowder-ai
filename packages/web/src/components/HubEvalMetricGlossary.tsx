import type { EvalMetricGlossary, EvalMetricGlossaryEntry } from './HubEvalTypes';

const GOOD_DIRECTION_LABELS: Record<EvalMetricGlossaryEntry['goodDirection'], string> = {
  higher: '越高越好',
  lower: '越低越好',
  neutral: '看上下文',
};

export function HubEvalMetricGlossary({ glossary }: { glossary?: EvalMetricGlossary }) {
  const entries = Object.entries(glossary ?? {}).sort(([leftKey, left], [rightKey, right]) =>
    `${left.component ?? ''}:${leftKey}`.localeCompare(`${right.component ?? ''}:${rightKey}`),
  );

  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs font-medium text-cafe-secondary">
        指标说明{entries.length > 0 ? ` (${entries.length})` : ''}
      </summary>
      {entries.length === 0 ? (
        <p className="mt-2 text-xs text-cafe-muted">暂无指标说明</p>
      ) : (
        <ul className="mt-2 space-y-2 border-l border-cafe pl-3">
          {entries.map(([key, entry]) => (
            <li key={key} className="space-y-0.5 text-xs">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium text-cafe">{entry.label}</span>
                <span className="min-w-0 break-all font-mono text-cafe-muted">{key}</span>
                <span className="text-cafe-muted">{GOOD_DIRECTION_LABELS[entry.goodDirection]}</span>
              </div>
              <p className="leading-relaxed text-cafe-secondary">{entry.means}</p>
              {entry.badWhen ? <p className="text-cafe-muted">异常信号：{entry.badWhen}</p> : null}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
