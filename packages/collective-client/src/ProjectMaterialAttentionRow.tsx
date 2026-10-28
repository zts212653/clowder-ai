import { useEffect } from 'react';
import type { CollectiveRoadmapRecord } from './client-types.js';
import { useCollectiveLanguage } from './collective-copy.js';
import { useProjectMaterials } from './ProjectMaterialsContext.js';

export function ProjectMaterialAttentionRow({
  project,
  onOpen,
  onCount,
}: {
  project: CollectiveRoadmapRecord;
  onOpen(project: CollectiveRoadmapRecord): void;
  onCount(projectId: string, count: number): void;
}) {
  const source = useProjectMaterials(project.roadmapId),
    en = useCollectiveLanguage() === 'en',
    count = source.feed.pendingCount;
  useEffect(() => {
    onCount(project.roadmapId, count);
    return () => onCount(project.roadmapId, 0);
  }, [count, onCount, project.roadmapId]);
  if (!count) return null;
  return (
    <li>
      <span className="project-attention-status is-triage">{en ? 'To sort' : '待分拣'}</span>
      <div>
        <strong>{project.title}</strong>
        <span>{en ? `${count} new external items` : `来了 ${count} 份外部材料`}</span>
      </div>
      <button type="button" onClick={() => onOpen(project)}>
        {en ? 'Sort' : '去分拣'}
      </button>
    </li>
  );
}
