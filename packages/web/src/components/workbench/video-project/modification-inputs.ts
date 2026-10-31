import type {
  VideoProjectAssetVersion,
  VideoProjectReviewAnchor,
  VideoProjectReviewResult,
  VideoProjectReviewTarget,
  VideoProjectSegment,
  WorkspaceContentAnnotation,
} from '@cat-cafe/shared';
import type { ProjectSnapshot } from './api';

export function modificationBasis(annotation: WorkspaceContentAnnotation): {
  anchors: VideoProjectReviewAnchor[];
  result: VideoProjectReviewResult;
  actor: string;
  actorKind: 'human' | 'cat';
  reason?: string;
} {
  const history = annotation.projectHistory ?? [];
  const addressed = history
    .slice()
    .reverse()
    .find((event) => event.kind === 'addressed' && event.result);
  if (!addressed?.result || !('kind' in annotation.anchor) || annotation.anchor.kind !== 'video-project')
    throw new Error('尚无可核验的修改结果。');
  const location = history
    .slice(0, history.indexOf(addressed) + 1)
    .reverse()
    .find((event) => event.kind === 'located');
  return {
    anchors: location?.targets ?? [annotation.anchor],
    result: addressed.result,
    actor: addressed.actor.actorId,
    actorKind: addressed.actor.kind,
    reason: addressed.reason,
  };
}

export interface ModificationArtworkPair {
  id: string;
  visualUseId?: string;
  label: string;
  before: { ownerRevision: number; version: VideoProjectAssetVersion };
  after: { ownerRevision: number; version: VideoProjectAssetVersion };
}
export interface ModifiedProjectUse {
  id: string;
  kind: 'visual' | 'event';
  signature: string;
  description: string;
}
interface VisualUsage {
  segment: VideoProjectSegment;
  visual: VideoProjectSegment['visuals'][number];
  version?: VideoProjectAssetVersion;
}

export function modificationInputs(
  origins: { anchor: VideoProjectReviewAnchor; snapshot: ProjectSnapshot }[],
  after: ProjectSnapshot,
  namedAsset?: string,
): { pairs: ModificationArtworkPair[]; uses: ModifiedProjectUse[] } {
  const pairs = new Map<string, ModificationArtworkPair>();
  const uses = new Map<string, ModifiedProjectUse>();
  for (const origin of origins) {
    collectVisualChanges(pairs, uses, origin, after, namedAsset);
    collectEventChanges(uses, origin.snapshot, after, origin.anchor.target, namedAsset);
  }
  return { pairs: [...pairs.values()], uses: [...uses.values()] };
}

export function findModifiedUseAppearance(snapshot: ProjectSnapshot, use: ModifiedProjectUse): number | null {
  if (use.kind === 'visual') {
    const candidate = allVisuals(snapshot).find(
      (value) => value.visual.id === use.id && visualMaterial(value) === use.signature,
    );
    return candidate ? candidate.segment.startTick + candidate.visual.startTick : null;
  }
  const event = snapshot.document.timeline.events.find(
    (value) => value.id === use.id && eventSignature(snapshot, value) === use.signature,
  );
  return event?.startTick ?? null;
}

function collectVisualChanges(
  pairs: Map<string, ModificationArtworkPair>,
  uses: Map<string, ModifiedProjectUse>,
  origin: { anchor: VideoProjectReviewAnchor; snapshot: ProjectSnapshot },
  after: ProjectSnapshot,
  namedAsset?: string,
) {
  assertOriginBound(origin);
  const previous = scopedVisuals(origin.snapshot, origin.anchor.target);
  for (const usage of previous) {
    const next = allVisuals(after).find((value) => value.visual.id === usage.visual.id);
    if (next && (!namedAsset || next.visual.assetVersionRef === namedAsset))
      appendVisualChange(pairs, uses, origin, after, usage, next);
  }
  for (const next of afterVisuals(after, origin.anchor.target, namedAsset)) {
    if (
      previous.some((value) => value.visual.id === next.visual.id) ||
      (namedAsset && next.visual.assetVersionRef !== namedAsset)
    )
      continue;
    uses.set(`visual:${next.visual.id}`, {
      kind: 'visual',
      id: next.visual.id,
      signature: visualMaterial(next),
      description: `${next.segment.label} · ${next.visual.id}：画面使用已新增或移入这段范围。`,
    });
  }
}

function appendVisualChange(
  pairs: Map<string, ModificationArtworkPair>,
  uses: Map<string, ModifiedProjectUse>,
  origin: { anchor: VideoProjectReviewAnchor; snapshot: ProjectSnapshot },
  after: ProjectSnapshot,
  usage: VisualUsage,
  next: VisualUsage,
) {
  if (visualSignature(usage) === visualSignature(next)) return;
  uses.set(`visual:${next.visual.id}`, {
    kind: 'visual',
    id: next.visual.id,
    signature: visualMaterial(next),
    description: visualChangeDescription(usage, next, origin.snapshot, after),
  });
  if (!usage.version || !next.version || !png(usage.version) || !png(next.version)) return;
  if (usage.version.sha256 === next.version.sha256 && (usage.version.rotation ?? 0) === (next.version.rotation ?? 0))
    return;
  const id = `${origin.snapshot.ownerRevision}:${usage.visual.id}:${after.ownerRevision}`;
  pairs.set(id, {
    id,
    visualUseId: usage.visual.id,
    label: `${next.segment.label} · ${next.visual.id}`,
    before: { ownerRevision: origin.snapshot.ownerRevision, version: usage.version },
    after: { ownerRevision: after.ownerRevision, version: next.version },
  });
}
function collectEventChanges(
  uses: Map<string, ModifiedProjectUse>,
  before: ProjectSnapshot,
  after: ProjectSnapshot,
  target: VideoProjectReviewTarget,
  namedAsset?: string,
) {
  if (hasRegion(target)) return;
  const previous = scopedEvents(before, target);
  for (const event of scopedEvents(after, target)) {
    if (namedAsset && event.assetVersionRef !== namedAsset) continue;
    const signature = eventSignature(after, event);
    const old = previous.find((item) => item.id === event.id);
    if (old && eventSignature(before, old) === signature) continue;
    const label = { audio: '声音', subtitle: '字幕', dialogue: '对白', marker: '标记' }[event.kind];
    uses.set(`event:${event.id}`, {
      kind: 'event',
      id: event.id,
      signature,
      description: `${event.id}：${label}输入已变化。`,
    });
  }
}
function afterVisuals(snapshot: ProjectSnapshot, target: VideoProjectReviewTarget, namedAsset?: string) {
  if (target.kind !== 'artwork') return scopedVisuals(snapshot, target);
  if (target.visualUseId) return allVisuals(snapshot).filter((value) => value.visual.id === target.visualUseId);
  if (namedAsset) return allVisuals(snapshot).filter((value) => value.visual.assetVersionRef === namedAsset);
  const original = snapshot.document.assets
    .flatMap((asset) => asset.versions)
    .find((version) => version.id === target.assetVersionRef);
  return allVisuals(snapshot).filter(
    (value) =>
      value.visual.assetVersionRef === target.assetVersionRef ||
      (original && value.version && stableValue(assetMaterial(original)) === stableValue(assetMaterial(value.version))),
  );
}

function allVisuals(snapshot: ProjectSnapshot): VisualUsage[] {
  const versions = new Map(
    snapshot.document.assets.flatMap((asset) => asset.versions.map((version) => [version.id, version] as const)),
  );
  return snapshot.document.timeline.segments.flatMap((segment) =>
    segment.visuals.map((visual) => ({
      segment,
      visual,
      ...(visual.assetVersionRef ? { version: versions.get(visual.assetVersionRef) } : {}),
    })),
  );
}
function scopedVisuals(snapshot: ProjectSnapshot, target: VideoProjectReviewTarget) {
  return allVisuals(snapshot).filter(({ segment, visual }) => {
    if (target.kind === 'segment') return segment.id === target.segmentId;
    if (target.kind === 'artwork')
      return (
        visual.assetVersionRef === target.assetVersionRef && (!target.visualUseId || visual.id === target.visualUseId)
      );
    if (target.kind !== 'moment') return true;
    return (
      segment.startTick + visual.startTick < (target.endTick ?? target.tick + 1) &&
      segment.startTick + visual.endTick > target.tick
    );
  });
}
function scopedEvents(snapshot: ProjectSnapshot, target: VideoProjectReviewTarget) {
  return snapshot.document.timeline.events.filter((event) => {
    if (target.kind === 'artwork') return false;
    if (target.kind === 'segment') {
      const segment = snapshot.document.timeline.segments.find((value) => value.id === target.segmentId);
      return Boolean(
        segment &&
          event.startTick < segment.startTick + segment.durationTicks &&
          event.startTick + (event.durationTicks ?? 1) > segment.startTick,
      );
    }
    if (target.kind !== 'moment') return true;
    return (
      event.startTick < (target.endTick ?? target.tick + 1) &&
      event.startTick + (event.durationTicks ?? 1) > target.tick
    );
  });
}
function eventSignature(snapshot: ProjectSnapshot, event: ProjectSnapshot['document']['timeline']['events'][number]) {
  const version = snapshot.document.assets
    .flatMap((asset) => asset.versions)
    .find((value) => value.id === event.assetVersionRef);
  return stableValue({
    kind: event.kind,
    startTick: event.startTick,
    durationTicks: event.durationTicks,
    text: event.text,
    speaker: event.speaker,
    material: version ? assetMaterial(version) : null,
  });
}
function visualSignature(use: VisualUsage) {
  return stableValue({
    material: visualMaterial(use),
    segmentStart: use.segment.startTick,
    start: use.visual.startTick,
    end: use.visual.endTick,
  });
}
function visualMaterial(use: VisualUsage) {
  return stableValue(use.version ? assetMaterial(use.version) : use.visual.generated);
}
function visualChangeDescription(
  before: VisualUsage,
  after: VisualUsage,
  original: ProjectSnapshot,
  next: ProjectSnapshot,
) {
  const changes: string[] = [];
  if (visualMaterial(before) !== visualMaterial(after)) {
    const previousRotation = before.version?.rotation ?? 0,
      nextRotation = after.version?.rotation ?? 0;
    changes.push(
      previousRotation !== nextRotation ? `画稿方向由 ${previousRotation}°改为 ${nextRotation}°` : '画面输入已变化',
    );
  }
  const previousStart = before.segment.startTick + before.visual.startTick;
  const nextStart = after.segment.startTick + after.visual.startTick;
  if (previousStart !== nextStart)
    changes.push(`出现时间由 ${seconds(original, previousStart)} 改为 ${seconds(next, nextStart)}`);
  const previousEnd = before.segment.startTick + before.visual.endTick;
  const nextEnd = after.segment.startTick + after.visual.endTick;
  if (previousEnd !== nextEnd)
    changes.push(`结束时间由 ${seconds(original, previousEnd)} 改为 ${seconds(next, nextEnd)}`);
  return `${after.segment.label} · ${after.visual.id}：${changes.join('；')}。`;
}
function seconds(snapshot: ProjectSnapshot, tick: number) {
  const timebase = snapshot.document.timeline.timebase;
  return `${((tick * timebase.numerator) / timebase.denominator).toFixed(3)} 秒`;
}
function assetMaterial(version: VideoProjectAssetVersion) {
  return {
    sha256: version.sha256,
    mediaType: version.mediaType.trim().toLowerCase().split(';')[0],
    width: version.width,
    height: version.height,
    rotation: version.rotation ?? 0,
  };
}
function png(version: VideoProjectAssetVersion) {
  return version.mediaType.trim().toLowerCase().split(';')[0] === 'image/png';
}
function hasRegion(target: VideoProjectReviewTarget) {
  return (target.kind === 'artwork' || target.kind === 'moment') && target.region !== undefined;
}
function stableValue(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  const fields = Object.entries(value)
    .filter(([, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${fields.map(([key, value]) => `${JSON.stringify(key)}:${stableValue(value)}`).join(',')}}`;
}

function assertOriginBound(origin: { anchor: VideoProjectReviewAnchor; snapshot: ProjectSnapshot }) {
  if (
    origin.snapshot.blobDigest !== origin.anchor.baseRevision ||
    origin.snapshot.ownerRevision !== origin.anchor.baseOwnerRevision
  )
    throw new Error('原意见定位版本的摘要不匹配。');
  if (
    origin.anchor.target.kind === 'moment' &&
    (origin.anchor.target.timebase.numerator !== origin.snapshot.document.timeline.timebase.numerator ||
      origin.anchor.target.timebase.denominator !== origin.snapshot.document.timeline.timebase.denominator)
  )
    throw new Error('意见的时间坐标与原输入不匹配。');
}
