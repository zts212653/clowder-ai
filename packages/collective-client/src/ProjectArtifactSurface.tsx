import type { CollectiveRoadmapRecord, CollectiveWorkProjection } from './client-types.js';
import type { SharedArtifact } from './collective-artifact-client.js';

export type ProjectArtifactStatus = 'loading' | 'ready' | 'unavailable' | 'access_denied';

export function ProjectArtifactSurface({
  roadmap,
  works,
  artifacts,
  status,
  onOpen,
}: {
  readonly roadmap: CollectiveRoadmapRecord;
  readonly works: readonly CollectiveWorkProjection[];
  readonly artifacts: readonly SharedArtifact[];
  readonly status: ProjectArtifactStatus;
  readonly onOpen?: (artifact: SharedArtifact) => void;
}) {
  const projectArtifacts = artifactsForWorks(artifacts, new Set(works.map((work) => work.workId)));
  const workTitles = new Map(works.map((work) => [work.workId, work.title]));
  return (
    <section className="project-artifacts" aria-label="项目作品">
      <header>
        <div>
          <strong>作品</strong>
          <span>{status === 'ready' ? `${projectArtifacts.length} 件` : '读取状态未确认'}</span>
        </div>
        <small>{roadmap.title}</small>
      </header>
      {status !== 'ready' ? (
        <ProjectArtifactState status={status} />
      ) : projectArtifacts.length === 0 ? (
        <p className="project-artifact-empty">这个项目还没有作品。任务交回作品后，会按同一 Work 自动出现在这里。</p>
      ) : (
        <div className="project-artifact-grid">
          {projectArtifacts.map((artifact) => (
            <button
              key={artifact.artifactId}
              type="button"
              className="project-artifact-card"
              onClick={() => onOpen?.(artifact)}
            >
              <span aria-hidden="true" className="project-artifact-icon">
                <svg aria-hidden="true" viewBox="0 0 32 36" fill="none" stroke="currentColor" strokeWidth="1.3">
                  <path d="M8 3h12l6 6v24H6V3h2Zm12 0v7h6M10 17h12M10 22h12M10 27h8" />
                </svg>
              </span>
              <span>
                <strong>{artifact.title}</strong>
                <small>
                  {workTitles.get(artifact.workId ?? '') ?? '项目任务'} · 第{' '}
                  {artifact.versions.at(-1)?.ownerRevision ?? 1} 版
                </small>
                <small>
                  #{artifact.sourceLocation.channelId}
                  {artifact.availability === 'owner_unavailable' ? ' · 内容所在的 Café 暂时不可用' : ''}
                </small>
              </span>
              <span aria-hidden="true">›</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

export function ProjectArtifactSummary({
  works,
  artifacts,
  status,
  onOpen,
}: {
  readonly works: readonly CollectiveWorkProjection[];
  readonly artifacts: readonly SharedArtifact[];
  readonly status: ProjectArtifactStatus;
  readonly onOpen?: (artifact: SharedArtifact) => void;
}) {
  if (status !== 'ready') return <ProjectArtifactState status={status} compact />;
  const latest = artifactsForWorks(artifacts, new Set(works.map((work) => work.workId)))[0];
  if (!latest) return <span className="project-list-artifact-empty">还没有作品</span>;
  return (
    <button type="button" className="project-list-artifact" onClick={() => onOpen?.(latest)}>
      <strong>{latest.title}</strong>
      <small>
        第 {latest.versions.at(-1)?.ownerRevision ?? 1} 版 · {new Date(latest.updatedAt).toLocaleDateString('zh-CN')}
      </small>
    </button>
  );
}

function ProjectArtifactState({
  status,
  compact = false,
}: {
  readonly status: ProjectArtifactStatus;
  readonly compact?: boolean;
}) {
  const label =
    status === 'loading'
      ? '正在读取作品…'
      : status === 'access_denied'
        ? compact
          ? '无权读取作品'
          : '你无权读取这个项目的作品。'
        : compact
          ? '作品暂时不可读'
          : '暂时读不到这个项目的作品，请稍后重试。';
  return <p className={compact ? 'project-list-artifact-empty' : 'project-artifact-empty'}>{label}</p>;
}

function artifactsForWorks(
  artifacts: readonly SharedArtifact[],
  workIds: ReadonlySet<string>,
): readonly SharedArtifact[] {
  return artifacts
    .filter((artifact) => Boolean(artifact.workId && workIds.has(artifact.workId)))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}
