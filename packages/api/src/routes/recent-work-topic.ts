import type { TaskItem } from '@cat-cafe/shared';
import type { Thread } from '../domains/cats/services/stores/ports/ThreadStore.js';
import type { RoadmapPointer } from '../domains/workspace/thread-roadmap-source.js';

const normalize = (value: string) => value.normalize('NFKC').toLowerCase();

/** Caller-selected clues, not a background classifier or a relevance score. */
export function directoryTopicTerms(topic: string | undefined): string[] {
  if (!topic) return [];
  return [
    ...new Set(
      normalize(topic)
        .split(/[\s,，、]+/u)
        .filter(Boolean),
    ),
  ].slice(0, 6);
}

export function matchingTopicTerms(value: string | null | undefined, terms: readonly string[]): string[] {
  if (!value) return [];
  const text = normalize(value);
  return terms.filter((term) => text.includes(term));
}

export function taskTopicMatch(task: TaskItem, terms: readonly string[]) {
  const title = matchingTopicTerms(task.title, terms);
  const feature = matchingTopicTerms(task.relatedFeatureId, terms);
  const artifactRefs = [task.subjectKey, ...(task.entrustedWork?.artifactRefs ?? [])]
    .filter((ref): ref is string => Boolean(ref))
    .filter((ref) => matchingTopicTerms(ref, terms).length > 0);
  return {
    sources: [
      ...(title.length ? ['task_title'] : []),
      ...(feature.length ? ['task_feature'] : []),
      ...(artifactRefs.length ? ['task_artifact_ref'] : []),
    ],
    artifactRefs: artifactRefs.slice(0, 3),
  };
}

export function threadTopicMatch(
  thread: Thread,
  terms: readonly string[],
  taskSources: readonly string[],
  roadmap: RoadmapPointer | undefined,
) {
  const title = matchingTopicTerms(thread.title, terms);
  const roadmapMatch = roadmap?.status === 'available' && matchingTopicTerms(roadmap.path, terms).length > 0;
  return {
    method: 'literal_metadata',
    originalContentRead: false,
    applicability: 'unassessed',
    sources: [
      ...new Set([
        ...(title.length ? ['thread_title'] : []),
        ...taskSources,
        ...(roadmapMatch ? ['roadmap_binding'] : []),
      ]),
    ],
  };
}

/** These are existing independently authorized tools, not sources inspected by the directory. */
export function directoryNextSources(topic: string | undefined) {
  return [
    {
      tool: 'cat_cafe_work',
      args: { command: { action: 'list' } },
      purpose: '查已登记Work；从version.threadId回原线，再读固定版本与当前语境',
    },
    {
      tool: 'cat_cafe_search_evidence',
      ...(topic ? { args: { query: topic } } : { requiredInput: 'query: 从当前标题与原问题明确选择短主题后再调用' }),
      purpose: '按需检索资料；查询范围、版本、资格和失败以该工具实返为准',
    },
  ];
}
