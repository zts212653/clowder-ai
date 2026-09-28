import type { EvolutionExplorationDetailV1 } from '@cat-cafe/shared';

/** The main view, comparison and compact summary must disclose the same record failure. */
export function ExplorationDetailStatus({
  detail,
  label = '本轮记录',
  retry,
}: {
  detail?: EvolutionExplorationDetailV1;
  label?: string;
  retry(): void;
}) {
  if (!detail || detail.status === 'resolved') return null;
  return (
    <p role="status" className="exploration-notice">
      {label}：{detail.reason}
      <button type="button" onClick={retry}>
        {detail.status === 'invalid' ? `核对后重读${label}` : `重试${label}`}
      </button>
    </p>
  );
}
