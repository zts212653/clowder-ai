import type { RefinementCtx } from 'zod';
import type { VideoProjectDocumentV1 } from './video-project-document.js';

type Path = (string | number)[];

/** Reference validation is structural; authenticated editing authority belongs to F138. */
export function refineVideoProjectReferences(document: VideoProjectDocumentV1, ctx: RefinementCtx): void {
  const issue = (path: Path, message: string) => ctx.addIssue({ code: 'custom', path, message });
  const uniqueIds = (items: readonly { id: string }[], path: Path): Set<string> => {
    const ids = new Set<string>();
    items.forEach((item, index) => {
      if (ids.has(item.id)) issue([...path, index, 'id'], 'ID must be unique');
      ids.add(item.id);
    });
    return ids;
  };
  const references = (values: readonly string[], allowed: ReadonlySet<string>, path: Path) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (!allowed.has(value)) issue([...path, index], 'Reference is not in this project');
      if (seen.has(value)) issue([...path, index], 'Reference must be unique');
      seen.add(value);
    });
  };
  const sceneIds = uniqueIds(document.timeline.scenes, ['timeline', 'scenes']);
  const segmentIds = uniqueIds(document.timeline.segments, ['timeline', 'segments']);
  const assetIds = uniqueIds(document.assets, ['assets']);
  const pageIds = uniqueIds(document.checkPages, ['checkPages']);
  uniqueIds(document.timeline.events, ['timeline', 'events']);
  uniqueIds(document.checkResults, ['checkResults']);
  uniqueIds(document.decisions, ['decisions']);

  const versionIds = new Set<string>();
  document.assets.forEach((asset, assetIndex) => {
    asset.versions.forEach((version, versionIndex) => {
      if (versionIds.has(version.id))
        issue(['assets', assetIndex, 'versions', versionIndex, 'id'], 'Asset version ID must be globally unique');
      versionIds.add(version.id);
    });
  });
  const visualIds = new Set<string>();
  document.timeline.segments.forEach((segment, segmentIndex) => {
    const path = ['timeline', 'segments', segmentIndex];
    if (segment.sceneId !== undefined) references([segment.sceneId], sceneIds, [...path, 'sceneId']);
    segment.visuals.forEach((visual, visualIndex) => {
      const visualPath = [...path, 'visuals', visualIndex];
      if (visualIds.has(visual.id)) issue([...visualPath, 'id'], 'Visual usage ID must be globally unique');
      visualIds.add(visual.id);
      if (visual.assetVersionRef !== undefined)
        references([visual.assetVersionRef], versionIds, [...visualPath, 'assetVersionRef']);
    });
  });
  document.timeline.events.forEach((event, index) => {
    if (event.assetVersionRef !== undefined)
      references([event.assetVersionRef], versionIds, ['timeline', 'events', index, 'assetVersionRef']);
    if (event.segmentId !== undefined)
      references([event.segmentId], segmentIds, ['timeline', 'events', index, 'segmentId']);
  });
  document.checkPages.forEach((page, index) => {
    references(page.references, versionIds, ['checkPages', index, 'references']);
    if (page.scope.kind === 'selectedScenes')
      references(page.scope.sceneIds, sceneIds, ['checkPages', index, 'scope', 'sceneIds']);
  });
  document.checkResults.forEach((result, index) => {
    const path = ['checkResults', index];
    references([result.pageId], pageIds, [...path, 'pageId']);
    references([result.sceneId], sceneIds, [...path, 'sceneId']);
    if (result.kind === 'sheet') references(result.assetVersionRefs, versionIds, [...path, 'assetVersionRefs']);
    else {
      references([result.coveredByPageId], pageIds, [...path, 'coveredByPageId']);
      if (result.pageId === result.coveredByPageId) issue([...path, 'coveredByPageId'], 'A page cannot cover itself');
    }
  });
  refineCoverageCycles(document, issue);
  document.decisions.forEach((decision, index) => {
    const path = ['decisions', index];
    references(decision.targets.sceneIds, sceneIds, [...path, 'targets', 'sceneIds']);
    references(decision.targets.segmentIds, segmentIds, [...path, 'targets', 'segmentIds']);
    references(decision.targets.assetIds, assetIds, [...path, 'targets', 'assetIds']);
    uniqueIds(decision.options ?? [], [...path, 'options']);
    decision.options?.forEach((option, optionIndex) => {
      references(option.assetVersionRefs ?? [], versionIds, [...path, 'options', optionIndex, 'assetVersionRefs']);
    });
    const operationIds = new Set<string>();
    decision.history.forEach((event, eventIndex) => {
      if (operationIds.has(event.operationId))
        issue([...path, 'history', eventIndex, 'operationId'], 'Decision history operation must be unique');
      operationIds.add(event.operationId);
    });
  });
}

/** Old input revisions remain separate snapshots; reversed later coverage is not an old cycle. */
function refineCoverageCycles(document: VideoProjectDocumentV1, issue: (path: Path, message: string) => void): void {
  const snapshots = new Map<string, Map<string, Set<string>>>();
  document.checkResults.forEach((result) => {
    if (result.kind !== 'coveredBy') return;
    const key = JSON.stringify([result.sceneId, result.inputOwnerRevision]);
    const edges = snapshots.get(key) ?? new Map<string, Set<string>>();
    const targets = edges.get(result.pageId) ?? new Set<string>();
    targets.add(result.coveredByPageId);
    edges.set(result.pageId, targets);
    snapshots.set(key, edges);
  });
  for (const edges of snapshots.values()) {
    if (coverageGraphHasCycle(edges))
      issue(['checkResults'], 'Same-scene coverage must not form a cycle within an input revision');
  }
}

function coverageGraphHasCycle(edges: ReadonlyMap<string, ReadonlySet<string>>): boolean {
  const indegrees = new Map<string, number>();
  for (const [source, targets] of edges) {
    if (!indegrees.has(source)) indegrees.set(source, 0);
    for (const target of targets) indegrees.set(target, (indegrees.get(target) ?? 0) + 1);
  }
  const pending = [...indegrees].filter(([, degree]) => degree === 0).map(([id]) => id);
  let visited = 0;
  for (const source of pending) {
    visited++;
    for (const target of edges.get(source) ?? []) {
      const degree = (indegrees.get(target) ?? 0) - 1;
      indegrees.set(target, degree);
      if (degree === 0) pending.push(target);
    }
  }
  return visited !== indegrees.size;
}
