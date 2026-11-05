import { useState } from 'react';
import type { CollectiveRoadmapRecord, CollectiveWorkProjection } from './client-types.js';
import type { SharedArtifact, SharedArtifactOpenOptions } from './collective-artifact-client.js';
import { MaterialDialogFrame } from './MaterialDialogFrame.js';
import { ProjectArtifactReferenceCard } from './ProjectArtifactReferenceCard.js';
import { ProjectArtifactVersionDialog } from './ProjectArtifactVersionDialog.js';
import { useProjectArtifactText } from './project-artifact-copy.js';
import { useProjectArtifactReferences } from './use-project-artifact-references.js';

export type ProjectArtifactOpen = (
  artifact: SharedArtifact,
  ownerRevision?: number,
  options?: SharedArtifactOpenOptions,
) => void;
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
  readonly onOpen?: ProjectArtifactOpen;
}) {
  const t = useProjectArtifactText(),
    refs = useProjectArtifactReferences(roadmap.roadmapId);
  const [picker, setPicker] = useState(false),
    [selected, setSelected] = useState<SharedArtifact>();
  const [notice, setNotice] = useState<string>();
  const items = refs.feed?.items ?? [],
    owner = refs.shared?.humanId === roadmap.accountableHumanId;
  const legacy = artifactsForWorks(artifacts, new Set(works.map((work) => work.workId))).filter(
    (artifact) =>
      !items.some((item) => item.reference.artifactId === artifact.artifactId) &&
      !refs.feed?.removedReferences.some((ref) => ref.artifactId === artifact.artifactId),
  );
  const change: Parameters<typeof ProjectArtifactReferenceCard>[0]['onChange'] = async (input) => {
    if (!refs.client) throw new Error('Project unavailable');
    const result = await refs.client.change(input);
    await refs.reload(true);
    if (result.outcome === 'conflict') setNotice(t('这处引用刚被改过，已显示现在实际使用的版本；请重新选择。'));
    else setNotice(undefined);
    return result.outcome !== 'conflict';
  };
  return (
    <section className="project-artifacts project-references" aria-label={t('项目作品')}>
      <header>
        <div>
          <strong>{t('作品')}</strong>
          <small>{t('本项目用的版本')}</small>
        </div>
        {owner && refs.client && (
          <button type="button" onClick={() => setPicker(true)}>
            {t('引用作品…')}
          </button>
        )}
      </header>
      <p className="project-reference-explanation">
        {t('本项目引用的是原作品的明确版本。新版只提示，换用只改本项目。')}
      </p>
      {notice && <p role="status">{notice}</p>}
      {refs.error ? (
        <p role="alert">
          {t(refs.error)}{' '}
          <button type="button" onClick={() => void refs.reload()}>
            {t('重新读取')}
          </button>
        </p>
      ) : refs.client && !refs.feed ? (
        <p className="project-artifact-empty">{t('正在读取版本记录…')}</p>
      ) : status !== 'ready' ? (
        <ProjectArtifactState status={status} />
      ) : (
        <>
          {items.map((item) => (
            <ProjectArtifactReferenceCard
              key={item.reference.referenceId}
              item={item}
              owner={owner}
              sourceChannelId={roadmap.sourceLocation.channelId}
              onChange={change}
              onOpen={onOpen}
            />
          ))}
          {refs.feed?.nextOffset !== undefined && (
            <button type="button" onClick={() => void refs.more()}>
              {t('更多作品')}
            </button>
          )}
          {!items.length && !legacy.length && <p className="project-artifact-empty">{t('还没有引用作品。')}</p>}
          {legacy.length > 0 && (
            <div className="project-artifact-grid">
              {legacy.map((artifact) => (
                <button
                  type="button"
                  className="project-artifact-card"
                  key={artifact.artifactId}
                  onClick={() => onOpen?.(artifact)}
                >
                  <span />
                  <span>
                    <strong>{artifact.title}</strong>
                    <small>{t('还未选择本项目版本')}</small>
                  </span>
                  <span>›</span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {picker && (
        <MaterialDialogFrame label={t('引用作品')} onClose={() => setPicker(false)}>
          <h2>{t('引用作品')}</h2>
          <div className="project-reference-picker">
            {artifacts
              .filter(
                (artifact) =>
                  artifact.availability === 'available' &&
                  !items.some((item) => item.reference.artifactId === artifact.artifactId),
              )
              .map((artifact) => (
                <button
                  type="button"
                  key={artifact.artifactId}
                  onClick={() => {
                    setSelected(artifact);
                    setPicker(false);
                  }}
                >
                  <strong>{artifact.title}</strong>
                  <small>
                    #{artifact.sourceLocation.channelId} ·{' '}
                    {refs.shared?.humanName?.(artifact.publishedByHumanId) ?? t('共同体成员')}
                  </small>
                  <small>
                    {t('当前可读最新版')} v{artifact.versions.at(-1)?.ownerRevision}
                  </small>
                </button>
              ))}
          </div>
          {!artifacts.length && <p>{t('没有可引用的作品。')}</p>}
          <footer>
            <button type="button" onClick={() => setPicker(false)}>
              {t('取消')}
            </button>
          </footer>
        </MaterialDialogFrame>
      )}
      {selected && (
        <ProjectArtifactVersionDialog
          artifact={selected}
          roadmapId={roadmap.roadmapId}
          projectChannelId={roadmap.sourceLocation.channelId}
          expectedRevision={
            refs.feed?.removedReferences.find((ref) => ref.artifactId === selected.artifactId)?.revision ?? 0
          }
          action="attach"
          onChange={change}
          onOpen={onOpen}
          onClose={() => setSelected(undefined)}
        />
      )}
    </section>
  );
}

export function ProjectArtifactSummary({
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
  readonly onOpen?: ProjectArtifactOpen;
}) {
  const t = useProjectArtifactText(),
    refs = useProjectArtifactReferences(roadmap.roadmapId);
  if (status !== 'ready') return <ProjectArtifactState status={status} compact />;
  if (refs.error) return <span className="project-list-artifact-empty">{t(refs.error)}</span>;
  const item = refs.feed?.items[0];
  if (item)
    return item.artifact && item.availability === 'available' ? (
      <button
        type="button"
        className="project-list-artifact"
        onClick={() =>
          onOpen?.(item.artifact!, item.reference.versionRef.ownerRevision, {
            projectReturn: {
              roadmapId: item.reference.roadmapId,
              referenceId: item.reference.referenceId,
              channelId: roadmap.sourceLocation.channelId,
            },
          })
        }
      >
        <strong>{item.artifact.title}</strong>
        <small>
          {t('本项目用的版本')} v{item.reference.versionRef.ownerRevision}
        </small>
      </button>
    ) : (
      <span className="project-list-artifact-empty">
        {t('这件作品现在打不开')} · v{item.reference.versionRef.ownerRevision}
      </span>
    );
  const latest = artifactsForWorks(artifacts, new Set(works.map((work) => work.workId))).find(
    (artifact) => !refs.feed?.removedReferences.some((ref) => ref.artifactId === artifact.artifactId),
  );
  if (!latest) return <span className="project-list-artifact-empty">{t('还没有引用作品。')}</span>;
  return (
    <button type="button" className="project-list-artifact" onClick={() => onOpen?.(latest)}>
      <strong>{latest.title}</strong>
      <small>{t('还未选择本项目版本')}</small>
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
  const t = useProjectArtifactText();
  const label =
    status === 'loading'
      ? '正在读取作品…'
      : status === 'access_denied'
        ? '你无权读取这个项目的作品。'
        : '暂时读不到这个项目的作品，请稍后重试。';
  return <p className={compact ? 'project-list-artifact-empty' : 'project-artifact-empty'}>{t(label)}</p>;
}
function artifactsForWorks(artifacts: readonly SharedArtifact[], workIds: ReadonlySet<string>) {
  return artifacts
    .filter((artifact) => Boolean(artifact.workId && workIds.has(artifact.workId)))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
