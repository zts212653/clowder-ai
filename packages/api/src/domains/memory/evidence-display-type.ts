import type { EvidenceItem } from './interfaces.js';

const LABELS: Record<string, string> = {
  feature: '功能',
  decision: '决策',
  plan: '计划',
  architecture: '设计规范',
  spec: '设计规范',
  lesson: '猫的笔记',
  research: '研究',
  discussion: '讨论',
  diary: '日记',
  'pack-knowledge': '资料',
};

/** One producer classification for document search and graph nodes. */
export function evidenceDisplayType(item: Pick<EvidenceItem, 'kind' | 'sourcePath'>): string {
  return item.sourcePath?.startsWith('bugs/') ? '缺陷报告' : (LABELS[item.kind] ?? '文档');
}
