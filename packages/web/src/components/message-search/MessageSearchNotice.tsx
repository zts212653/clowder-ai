import { type MessageSearchResponse, messageSearchNotice } from '@cat-cafe/shared';

export function MessageSearchNotice({ response }: { response: MessageSearchResponse }) {
  const notice = messageSearchNotice(response);
  const counts = notice.counts;
  return (
    <div
      aria-label="本次检索说明"
      role="status"
      className="space-y-1 border-b border-[var(--console-border-soft)] bg-[var(--console-hover-bg)] px-3 py-3 text-sm text-cafe-secondary"
    >
      <p className="font-medium text-cafe-black">{notice.summary}</p>
      {counts && (
        <p className="text-xs">
          本次候选 {counts.candidates}；已核对 {counts.assessed}：可支持 {counts.supported}、已排除 {counts.rejected}
          、无法确定 {counts.indeterminate}；尚未评估 {counts.unassessed}。
        </p>
      )}
      {notice.execution && <p className="text-xs">{notice.execution}</p>}
      <p>{notice.nextStep}</p>
      <p className="text-xs text-cafe-muted">{notice.coverage}</p>
    </div>
  );
}
