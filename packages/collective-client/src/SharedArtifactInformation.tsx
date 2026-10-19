import { useEffect, useRef } from 'react';
import type { SharedArtifact } from './collective-artifact-client.js';
import { SharedArtifactManagement } from './SharedArtifactManagement.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';

/** A non-modal information layer: the original discussion and reading state remain mounted. */
export function SharedArtifactInformation({
  artifact,
  managementArtifact,
  ownerRevision,
  onClose,
  onReturnToSource,
}: {
  readonly artifact?: SharedArtifact;
  readonly managementArtifact?: SharedArtifact;
  readonly ownerRevision?: number;
  readonly onClose: () => void;
  readonly onReturnToSource: () => void;
}) {
  const shared = useSharedArtifacts();
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus();
  }, []);
  return (
    <dialog
      open
      className="shared-artifact-information"
      aria-label="作品信息"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <header>
        <h2>作品信息</h2>
        <button ref={close} type="button" aria-label="关闭作品信息" onClick={onClose}>
          ×
        </button>
      </header>
      {artifact && (
        <dl className="shared-artifact-info">
          <dt>版本</dt>
          <dd>第 {ownerRevision} 版</dd>
          <dt>来自</dt>
          <dd>
            <button type="button" onClick={onReturnToSource}>
              #{artifact.sourceLocation.channelId} · 原讨论
            </button>
          </dd>
          <dt>属于任务</dt>
          <dd>{artifact.workId ? '已关联原任务' : '这条讨论中的共同作品'}</dd>
          <dt>查看与批注</dt>
          <dd>有权访问这件作品的共同体成员</dd>
          <dt>采用修改</dt>
          <dd>{artifact.canApply ? '你有权采用修改' : '你可以参与讨论，采用由有权成员决定'}</dd>
        </dl>
      )}
      {shared?.status === 'ready' &&
        managementArtifact &&
        (managementArtifact.canManageAccess || managementArtifact.canManageCustody) && (
          <SharedArtifactManagement
            key={`${managementArtifact.serviceInstanceId}:${managementArtifact.collectiveId}:${managementArtifact.artifactId}`}
            artifact={managementArtifact}
          />
        )}
    </dialog>
  );
}
