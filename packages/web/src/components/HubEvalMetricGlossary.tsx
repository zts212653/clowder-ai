import { useEvalCopy } from './eval-workspace/eval-workspace.shell-copy';
import type { EvalMetricGlossary } from './HubEvalTypes';

export function HubEvalMetricGlossary({ glossary }: { glossary?: EvalMetricGlossary }) {
  const t = useEvalCopy();
  const entries = Object.entries(glossary ?? {}).sort(([leftKey, left], [rightKey, right]) =>
    `${left.component ?? ''}:${leftKey}`.localeCompare(`${right.component ?? ''}:${rightKey}`),
  );

  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs font-medium text-cafe-secondary">
        {t.metrics}
        {entries.length > 0 ? ` (${entries.length})` : ''}
      </summary>
      {entries.length === 0 ? (
        <p className="mt-2 text-xs text-cafe-muted">{t.noMetrics}</p>
      ) : (
        <ul className="mt-2 space-y-2 border-l border-cafe pl-3">
          {entries.map(([key, entry]) => (
            <li key={key} className="space-y-0.5 text-xs">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-medium text-cafe">{entry.label}</span>
                <span className="min-w-0 break-all font-mono text-cafe-muted">{key}</span>
                <span className="text-cafe-muted">{t[entry.goodDirection]}</span>
              </div>
              <p className="leading-relaxed text-cafe-secondary">{entry.means}</p>
              {entry.badWhen ? (
                <p className="text-cafe-muted">
                  {t.badSignal}: {entry.badWhen}
                </p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
