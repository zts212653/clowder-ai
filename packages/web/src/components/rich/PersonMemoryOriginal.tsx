import type { RichCardBlock } from '@cat-cafe/shared';
import { MarkdownContent } from '../MarkdownContent';
import { useShellLanguage } from '../shell/shell-language';

const fields: Record<string, string> = { 范围: 'Scope', 写入: 'Writing', 纠错: 'Correction' };
const values: Record<string, string> = {
  仅你的私人记忆: 'Only your private memory',
  '在 Approval Hub 逐项勾选后自动完成': 'Write only the drafts selected in Approvals',
  '新卡审批前会撤回旧卡，并保留替换关联':
    'The old card closes before approval of its replacement; the link is retained',
};
const kinds: Record<string, string> = {
  事实: 'Fact',
  人物关系: 'Relationship',
  互动事件: 'Interaction',
  第三方引述: 'Quoted third party',
};

/** Translate only producer template slots, preserving the person's words and names verbatim. */
export function personMemoryOriginalBody(body: string, english: boolean): string {
  if (!english) return body;
  let inQuotation = false;
  return body
    .split('\n')
    .map((line) => {
      // Original excerpts can span lines which resemble template labels. Never translate their content.
      if (inQuotation) {
        if (line.endsWith('”')) inQuotation = false;
        return line;
      }
      if (/^ {3}原话：“/.test(line)) {
        inQuotation = !line.endsWith('”');
        return line.replace('原话：', 'Original words: ');
      }
      const evidence = /^( {3})证据 (\d+)（([^）]*)）/.exec(line);
      if (evidence) {
        const labels: Record<string, string> = {
          事件类型: 'Event type',
          发生了什么: 'What happened',
          时间: 'When',
          时长: 'Duration',
          '主题/重要性': 'Topic or importance',
          不确定项: 'Uncertainties',
        };
        inQuotation = line.includes('：“') && !line.endsWith('”');
        return `${evidence[1]}Evidence ${evidence[2]} (${evidence[3]
          .split('、')
          .map((field) => labels[field] ?? field)
          .join(', ')})${line.slice(evidence[0].length).replace('：“', ': “')}`;
      }
      const typed = /^( {3})类型：(.+) · 来源：(.+)$/.exec(line);
      if (typed)
        return `${typed[1]}Type: ${kinds[typed[2]] ?? typed[2].replace(/^co-creator 判断$/, 'Owner assessment').replace(/ 判断$/, ' assessment')} · Source: ${kinds[typed[3]] ?? typed[3].replace(/^co-creator 明确陈述$/, 'Owner explicitly stated').replace(/ 明确陈述$/, ' explicitly stated')}`;
      const label = /^( {3})(原话|证据契约|人物|发生了什么|时间|时长|主题\/重要性|仍不确定)：/.exec(line);
      const labels: Record<string, string> = {
        原话: 'Original words',
        证据契约: 'Evidence contract',
        人物: 'Person',
        发生了什么: 'What happened',
        时间: 'When',
        时长: 'Duration',
        '主题/重要性': 'Topic or importance',
        仍不确定: 'Still uncertain',
      };
      return label
        ? `${label[1]}${labels[label[2]]}: ${line.slice(label[0].length)}`
        : line.replace(/^(\d+\. \*\*)互动事件(\*\*)$/, '$1Interaction$2');
    })
    .join('\n');
}

export function PersonMemoryOriginal({ block }: { block: RichCardBlock }) {
  const english = useShellLanguage() === 'en';
  return (
    <div data-testid="person-memory-original" className="min-w-0 space-y-2 text-xs">
      <MarkdownContent
        content={personMemoryOriginalBody(block.bodyMarkdown ?? '', english)}
        className="!text-xs"
        disableCommandPrefix
      />
      <dl className="space-y-1">
        {block.fields?.map((field, index) => (
          <div key={`${field.label}-${index}`}>
            <dt className="inline text-[var(--shell-muted)]">
              {english ? (fields[field.label] ?? field.label) : field.label}
              {english ? ': ' : '：'}
            </dt>
            <dd className="inline">
              {english
                ? (values[field.value] ?? field.value)
                : field.value === '在 Approval Hub 逐项勾选后自动完成'
                  ? '在审批中逐项勾选后自动完成'
                  : field.value}
            </dd>
          </div>
        ))}
      </dl>
    </div>
  );
}
