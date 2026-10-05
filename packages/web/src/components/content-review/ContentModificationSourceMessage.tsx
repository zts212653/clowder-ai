import { CONTENT_MODIFICATION_CLOSURES, contentModificationSourceMessageV1Schema } from '@cat-cafe/shared';

/** Human-authored intent stays in the normal message body; this is presentation of its verified owner metadata. */
export function ContentModificationSourceMessage({ metadata }: { metadata: unknown }) {
  const parsed = contentModificationSourceMessageV1Schema.safeParse(metadata);
  if (!parsed.success) return null;
  const source = parsed.data;
  return (
    <div className="mb-2 min-w-0" data-testid="content-modification-source">
      <p className="break-words text-sm font-semibold">
        请{source.targetName}修改《{source.contentTitle}》
      </p>
      <details className="mt-1 text-xs opacity-80">
        <summary className="cursor-pointer">修改请求详情</summary>
        <p className="mt-1 break-words">执行对话：{source.executionThreadTitle}</p>
        <p className="mt-1">{CONTENT_MODIFICATION_CLOSURES[source.completionRule]}</p>
      </details>
    </div>
  );
}
