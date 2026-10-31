import { MarkdownContent } from '../MarkdownContent';

const headlines: Record<string, string> = {
  terminal_report: '执行现场已回报，原负责人将核验并继续',
  deadline_review: '复核时间已到，原负责人将核对当前进展',
  owner_changed: '原责任已变化，这次开发回流已停止',
};

/** Human headline for a cat-facing return; preserve the original machine body in the disclosure. */
export function DevelopmentReturnBody({ content, reason }: { content: string; reason?: string }) {
  const headline = (reason && headlines[reason]) || '开发回流有新消息，原负责人需核对详情';
  return (
    <details className="text-sm">
      <summary className="cursor-pointer select-none">{headline}</summary>
      <div className="mt-2 text-xs text-cafe-secondary">
        <MarkdownContent content={content} />
      </div>
    </details>
  );
}
