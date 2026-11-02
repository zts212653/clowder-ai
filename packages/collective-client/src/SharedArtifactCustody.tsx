import type { CollectiveArtifactManagement } from '@cat-cafe/shared';
import { useState } from 'react';
import type { SharedArtifact } from './collective-artifact-client.js';
import { useCollectiveLanguage, useCollectiveText } from './collective-copy.js';
import { artifactCafeLabel } from './shared-artifact-member-label.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';
import type { useSharedArtifactManagement } from './use-shared-artifact-management.js';

export function SharedArtifactCustody({
  artifact,
  management,
}: {
  readonly artifact: SharedArtifact;
  readonly management: ReturnType<typeof useSharedArtifactManagement>;
}) {
  const language = useCollectiveLanguage();
  const t = useCollectiveText();
  const shared = useSharedArtifacts();
  const [target, setTarget] = useState('');
  const { api, value, pending, unconfirmed } = management;
  if (!value) return null;
  const transfer = value.transfer;
  const active = transfer && !['committed', 'cancelled'].includes(transfer.state);
  const blocked = pending || unconfirmed;
  const directory = shared?.members;
  const eligible = new Set(value.members.filter((member) => member.canReceiveCustody).map((member) => member.humanId));
  const cafes =
    directory?.cafes.filter(
      (cafe) => eligible.has(cafe.humanId) && cafe.connectionId !== value.custodianCafe?.connectionId,
    ) ?? [];
  const destination = cafes.find((cafe) => cafe.connectionId === target);
  const custodianLabel = !value.custodianHumanId
    ? undefined
    : value.custodianCafe && directory
      ? artifactCafeLabel({ ...value.custodianCafe, humanId: value.custodianHumanId }, directory)
      : language === 'en'
        ? `${shared?.humanName(value.custodianHumanId) ?? t('成员')}'s Café`
        : `${shared?.humanName(value.custodianHumanId) ?? '成员'}的 Café`;
  return (
    <div>
      <h3>{t('保管作品')}</h3>
      <p>
        {value.custodianHumanId
          ? language === 'en'
            ? `${custodianLabel} keeps the document, versions, and collaboration history.`
            : `${custodianLabel} 保管正文、版本和协作记录。`
          : t('当前保管方暂时无法确认。')}
      </p>
      {transfer && <output>{t(transferLabel(transfer))}</output>}
      {transfer?.targetCafe && directory && (
        <p>
          {t('本次交接目的地')}：
          {artifactCafeLabel({ ...transfer.targetCafe, humanId: transfer.targetHumanId }, directory)}
        </p>
      )}
      {active && value.canManageCustody && (
        <button
          type="button"
          disabled={blocked}
          onClick={() => void management.run(async () => api?.cancel(artifact, transfer.transferId))}
        >
          {t('取消这次交接')}
        </button>
      )}
      {!active && value.canManageCustody && (
        <>
          <label>
            {t('交接给')}
            <select
              aria-label={t('作品接收 Café')}
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              disabled={blocked}
            >
              <option value="">{t('选择成员与 Café')}</option>
              {cafes.map((cafe) => (
                <option key={cafe.connectionId} value={cafe.connectionId}>
                  {directory ? artifactCafeLabel(cafe, directory) : cafe.endpointLabel}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={blocked || !value.custodyAvailable || !destination}
            onClick={() =>
              void management.run(async () => {
                if (!destination) return;
                await shared?.api?.read(artifact);
                await api?.offer(artifact, destination.humanId, value.custodyRevision, destination.connectionId);
              })
            }
          >
            {t('交接作品与记录')}
          </button>
          <p>{t('交接保留原来源与权限，作品和全部记录核对完成后才切换保管方。')}</p>
        </>
      )}
    </div>
  );
}

function transferLabel(transfer: NonNullable<CollectiveArtifactManagement['transfer']>) {
  switch (transfer.state) {
    case 'offered':
      return '已发起交接，等待原 Café 准备。';
    case 'source_prepared':
      return '原 Café 已准备好，等待接收作品与记录。';
    case 'target_ready':
      return '接收 Café 已核对，等待确认交接。';
    case 'committed':
      return transfer.targetFinalized ? '作品与记录已交接。' : '已确认交接，等待接收 Café 恢复访问。';
    case 'cancelled':
      return '交接已取消。';
  }
}
