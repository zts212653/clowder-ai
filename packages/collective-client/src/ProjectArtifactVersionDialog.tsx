import type { CollectiveProjectArtifactItem, CollectiveProjectArtifactVersionRef } from '@cat-cafe/shared';
import { useState } from 'react';
import type { SharedArtifact } from './collective-artifact-client.js';
import { MaterialDialogFrame } from './MaterialDialogFrame.js';
import type { ProjectArtifactOpen } from './ProjectArtifactSurface.js';
import type { ProjectArtifactChange } from './project-artifact-client.js';
import { useProjectArtifactText } from './project-artifact-copy.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';
import { useSharedArtifactVersionHistory } from './use-shared-artifact-version-history.js';

export function ProjectArtifactVersionDialog({
  artifact,
  item,
  roadmapId,
  projectChannelId,
  action,
  expectedRevision,
  onChange,
  onOpen,
  onClose,
}: {
  artifact?: SharedArtifact;
  item?: CollectiveProjectArtifactItem;
  roadmapId: string;
  projectChannelId: string;
  action: 'attach' | 'switch' | 'remove';
  expectedRevision: number;
  onChange(change: ProjectArtifactChange): Promise<boolean>;
  onOpen?: ProjectArtifactOpen;
  onClose(): void;
}) {
  const t = useProjectArtifactText(),
    shared = useSharedArtifacts();
  const [target, setTarget] = useState(
    artifact?.versions.at(-1)?.ownerRevision ?? item?.reference.versionRef.ownerRevision ?? 1,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string>();
  const title = t(action === 'attach' ? '引用作品' : action === 'switch' ? '换用作品版本' : '从项目移出作品');
  const submit = async (versionRef?: CollectiveProjectArtifactVersionRef) => {
    setBusy(true);
    setError(undefined);
    try {
      const base = { roadmapId, artifactId: artifact?.artifactId ?? item!.reference.artifactId, expectedRevision };
      const changed = await onChange(
        action === 'remove' ? { ...base, action } : { ...base, action, versionRef: versionRef! },
      );
      if (changed) onClose();
      else setError(t('这处引用刚被改过，已显示现在实际使用的版本；请重新选择。'));
    } catch {
      setError(t('操作尚未确认，请重试。'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <MaterialDialogFrame label={title} onClose={onClose} busy={busy}>
      <h2>{title}</h2>
      <p>{artifact?.title ?? t('这件作品现在打不开')}</p>
      {artifact && (
        <p>
          #{artifact.sourceLocation.channelId} · {shared?.humanName?.(artifact.publishedByHumanId) ?? t('共同体成员')}
        </p>
      )}
      {item && (
        <p>
          {t('现在用')} <strong>v{item.reference.versionRef.ownerRevision}</strong>
        </p>
      )}
      {action === 'remove' ? (
        <>
          <p>{t('移出只解除本项目的引用，不删除原件或其他项目的引用。')}</p>
          {error && <p role="alert">{error}</p>}
          <footer>
            <button type="button" disabled={busy} onClick={onClose}>
              {t('取消')}
            </button>
            <button type="button" disabled={busy} onClick={() => void submit()}>
              {t('移出')}
            </button>
          </footer>
        </>
      ) : (
        artifact && (
          <VersionChoice
            artifact={artifact}
            selected={target}
            current={item?.reference.versionRef.ownerRevision}
            onSelect={setTarget}
          >
            {(version) => (
              <>
                <p>{t('只改这个项目，其他项目与原件、旧版都不变。')}</p>
                {item &&
                  version &&
                  artifact.mediaType === 'text/markdown' &&
                  version.ownerRevision !== item.reference.versionRef.ownerRevision && (
                    <button
                      type="button"
                      onClick={() =>
                        onOpen?.(
                          artifact,
                          artifact.mediaType === 'text/markdown'
                            ? item.reference.versionRef.ownerRevision
                            : version.ownerRevision,
                          {
                            comparisonOwnerRevision: version.ownerRevision,
                            projectReturn: {
                              roadmapId,
                              referenceId: item.reference.referenceId,
                              channelId: projectChannelId,
                            },
                          },
                        )
                      }
                    >
                      {t('并排比较这两版')}
                    </button>
                  )}
                {version && (
                  <button
                    type="button"
                    onClick={() =>
                      onOpen?.(artifact, version.ownerRevision, {
                        projectReturn: {
                          roadmapId,
                          referenceId: item?.reference.referenceId,
                          channelId: projectChannelId,
                        },
                      })
                    }
                  >
                    {t('预览所选原件版本')} v{version.ownerRevision}
                  </button>
                )}
                <p>{t('合并内容请回原讨论，请保管人出候选，再批注和采用。')}</p>
                <button
                  type="button"
                  onClick={() => {
                    shared?.close();
                    shared?.returnToSource?.(artifact.sourceLocation.channelId, artifact.sourceEventId);
                  }}
                >
                  {t('返回原讨论')}
                </button>
                {error && <p role="alert">{error}</p>}
                <footer>
                  <button type="button" disabled={busy} onClick={onClose}>
                    {t('先不换')}
                  </button>
                  <button type="button" disabled={busy || !version} onClick={() => void submit(version)}>
                    {t(action === 'attach' ? '引用' : '换用')} v{target}
                  </button>
                </footer>
              </>
            )}
          </VersionChoice>
        )
      )}
    </MaterialDialogFrame>
  );
}

function VersionChoice({
  artifact,
  selected,
  current,
  onSelect,
  children,
}: {
  artifact: SharedArtifact;
  selected: number;
  current?: number;
  onSelect(value: number): void;
  children(version?: CollectiveProjectArtifactVersionRef): React.ReactNode;
}) {
  const t = useProjectArtifactText(),
    history = useSharedArtifactVersionHistory(artifact),
    shared = useSharedArtifacts();
  const versions = history.page?.versions ?? [];
  const selectedVersion = versions.find((version) => version.ownerRevision === selected);
  const selectedRef = selectedVersion && {
    ownerRevision: selectedVersion.ownerRevision,
    blobDigest: selectedVersion.blobDigest,
    receiptRef: selectedVersion.receiptRef,
  };
  return (
    <>
      <label>
        {t('选择版本')}
        <select value={selected} onChange={(event) => onSelect(Number(event.target.value))}>
          {versions.map((version) => (
            <option key={version.ownerRevision} value={version.ownerRevision}>
              v{version.ownerRevision}
              {current === version.ownerRevision ? ` · ${t('现在用')}` : ''}
            </option>
          ))}
        </select>
      </label>
      {history.pending && <output>{t('正在读取版本记录…')}</output>}
      {history.error && <p role="alert">{history.error}</p>}
      <ol className="project-reference-version-list">
        {versions.map((version) => (
          <li key={version.ownerRevision}>
            <strong>v{version.ownerRevision}</strong>
            <time>{new Date(version.recordedAt).toLocaleDateString()}</time>
            <span>
              {version.lineage
                ? `${shared?.humanName(version.adoptedByHumanId ?? '') ?? ''} · ${t('采用了修改')}`
                : t('分享的版本')}
            </span>
            <small>{version.changeSummary ?? t('未提供改动说明')}</small>
          </li>
        ))}
      </ol>
      {history.page?.nextOffset !== undefined && (
        <button type="button" disabled={history.pending} onClick={() => void history.more()}>
          {t('更早的版本')}
        </button>
      )}
      {children(selectedRef)}
    </>
  );
}
