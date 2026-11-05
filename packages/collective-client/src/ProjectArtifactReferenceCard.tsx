import type { CollectiveProjectArtifactItem } from '@cat-cafe/shared';
import { useState } from 'react';
import type { ProjectArtifactOpen } from './ProjectArtifactSurface.js';
import { ProjectArtifactVersionDialog } from './ProjectArtifactVersionDialog.js';
import type { ProjectArtifactChange } from './project-artifact-client.js';
import { useProjectArtifactText } from './project-artifact-copy.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';

export function ProjectArtifactReferenceCard({
  item,
  owner,
  sourceChannelId,
  onChange,
  onOpen,
}: {
  item: CollectiveProjectArtifactItem;
  owner: boolean;
  sourceChannelId: string;
  onChange(change: ProjectArtifactChange): Promise<boolean>;
  onOpen?: ProjectArtifactOpen;
}) {
  const t = useProjectArtifactText(),
    shared = useSharedArtifacts(),
    reference = item.reference;
  const [dialog, setDialog] = useState<'switch' | 'remove'>(),
    [error, setError] = useState(false),
    [busy, setBusy] = useState(false);
  const readable = item.availability === 'available',
    artifact = readable ? item.artifact : undefined;
  const keep = async () => {
    if (!item.latestVersionRef) return;
    setBusy(true);
    setError(false);
    try {
      setError(
        !(await onChange({
          roadmapId: reference.roadmapId,
          artifactId: reference.artifactId,
          action: 'keep',
          expectedRevision: reference.revision,
          versionRef: item.latestVersionRef,
        })),
      );
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <article className="project-reference-card" data-reference-id={reference.referenceId}>
      <div className="project-reference-title">
        <strong>{artifact?.title ?? t('这件作品现在打不开')}</strong>
        <small>
          {t('本项目用的版本')} · v{reference.versionRef.ownerRevision}
        </small>
      </div>
      {artifact ? (
        <>
          <small>
            {item.latestVersionRef
              ? `${t('当前可读最新版')} v${item.latestVersionRef.ownerRevision}`
              : t('最新版暂时不可确认')}
          </small>
          {item.usedBy
            .filter((project) => project.roadmapId !== reference.roadmapId)
            .map((project) => (
              <small key={project.roadmapId}>
                {project.title} · v{project.versionRef.ownerRevision}
              </small>
            ))}
          <div className="project-reference-actions">
            <button
              type="button"
              onClick={() =>
                onOpen?.(artifact, reference.versionRef.ownerRevision, {
                  projectReturn: {
                    roadmapId: reference.roadmapId,
                    referenceId: reference.referenceId,
                    channelId: sourceChannelId,
                  },
                })
              }
            >
              {t('打开本项目用的')} v{reference.versionRef.ownerRevision}
            </button>
            {item.hasUpdate && (
              <span className="project-reference-update">
                {t('有新版')} v{item.latestVersionRef?.ownerRevision}
              </span>
            )}
            {owner ? (
              <>
                <button type="button" onClick={() => setDialog('switch')}>
                  {t('换用…')}
                </button>
                {item.hasUpdate && (
                  <button type="button" disabled={busy} onClick={() => void keep()}>
                    {t('保持')} v{reference.versionRef.ownerRevision}
                  </button>
                )}
              </>
            ) : (
              item.hasUpdate && <small>{t('由项目负责人决定换不换。')}</small>
            )}
          </div>
          {!item.hasUpdate && reference.keptVersionRef && <small>{t('保持当前版本，以后仍可换用。')}</small>}
        </>
      ) : (
        <p>
          {t(
            item.availability === 'owner_unavailable' ? '内容所在的 Café 暂时不可用。' : '原件撤回了，或你没有权限了。',
          )}
        </p>
      )}
      {owner && (
        <button type="button" className="project-reference-remove" onClick={() => setDialog('remove')}>
          {t('移出…')}
        </button>
      )}
      {error && <p role="alert">{t('这处引用刚被改过，已显示现在实际使用的版本；请重新选择。')}</p>}
      <details>
        <summary>{t('动态')}</summary>
        <ol>
          {reference.history.toReversed().map((entry) => (
            <li key={entry.revision}>
              <time>{new Date(entry.at).toLocaleString()}</time> ·{' '}
              {entry.actor.kind === 'human' ? entry.actor.displayName : entry.actor.humanDisplayName} ·{' '}
              {t({ attach: '引用', switch: '换用', keep: '保持', remove: '移出' }[entry.action])} v
              {entry.versionRef.ownerRevision}
              <button type="button" onClick={() => shared?.returnToSource?.(sourceChannelId, entry.sourceEventId)}>
                {t('返回原讨论')}
              </button>
            </li>
          ))}
        </ol>
      </details>
      {dialog && (
        <ProjectArtifactVersionDialog
          key={`${reference.revision}:${dialog}`}
          artifact={artifact}
          item={item}
          roadmapId={reference.roadmapId}
          projectChannelId={sourceChannelId}
          expectedRevision={reference.revision}
          action={dialog}
          onChange={onChange}
          onOpen={onOpen}
          onClose={() => setDialog(undefined)}
        />
      )}
    </article>
  );
}
