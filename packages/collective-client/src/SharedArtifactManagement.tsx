import type { CollectiveArtifactManagement } from '@cat-cafe/shared';
import { useState } from 'react';
import type { SharedArtifact } from './collective-artifact-client.js';
import { useCollectiveLanguage, useCollectiveText } from './collective-copy.js';
import { SharedArtifactCustody } from './SharedArtifactCustody.js';
import { artifactMemberLabel } from './shared-artifact-member-label.js';
import { useSharedArtifacts } from './use-collective-artifacts.js';
import { useSharedArtifactManagement } from './use-shared-artifact-management.js';

export function SharedArtifactManagement({ artifact }: { readonly artifact: SharedArtifact }) {
  const language = useCollectiveLanguage();
  const t = useCollectiveText();
  const shared = useSharedArtifacts();
  const management = useSharedArtifactManagement(artifact);
  const { api, value, pending, unconfirmed } = management;
  const blocked = pending || unconfirmed;
  return (
    <section className="shared-artifact-management" aria-label={t('权限与保管')}>
      <h2>{t('权限与保管')}</h2>
      {!value && !management.error && <output>{t('正在核对…')}</output>}
      {management.error && <p role="alert">{t(management.error)}</p>}
      {unconfirmed && (
        <div role="status">
          <p>{t('上次操作尚未确认。')}</p>
          <button
            type="button"
            disabled={pending}
            onClick={() => void management.run(async () => api?.recover(artifact))}
          >
            {t('核对上次操作')}
          </button>
        </div>
      )}
      {value && (
        <>
          {value.canManageAccess && (
            <div>
              <h3>{t('成员的作品权限')}</h3>
              <p>{t('修改只作用于这件作品，采用权限由你明确授予。')}</p>
              {value.members.map(
                (member) =>
                  member.access &&
                  member.accessRevision !== undefined && (
                    <ArtifactMemberPermission
                      key={`${member.humanId}:${member.accessRevision}`}
                      member={member}
                      label={artifactMemberLabel(member, shared?.members)}
                      disabled={blocked}
                      onSave={(access) =>
                        void management.run(async () =>
                          api?.setAccess(artifact, member.humanId, access, member.accessRevision as number),
                        )
                      }
                    />
                  ),
              )}
            </div>
          )}
          <SharedArtifactCustody artifact={artifact} management={management} />
          {value.nextOffset !== undefined && (
            <button type="button" disabled={blocked} onClick={() => void management.more()}>
              {language === 'en'
                ? `More members (${value.members.length}/${value.total} read)`
                : `更多成员（已读 ${value.members.length}/${value.total}）`}
            </button>
          )}
        </>
      )}
      <button type="button" disabled={pending} onClick={() => void management.refresh()}>
        {t('重新读取权限与保管')}
      </button>
    </section>
  );
}

function ArtifactMemberPermission({
  member,
  label,
  disabled,
  onSave,
}: {
  readonly member: CollectiveArtifactManagement['members'][number];
  readonly label: string;
  readonly disabled: boolean;
  readonly onSave: (access: 'read' | 'apply' | 'revoked') => void;
}) {
  const language = useCollectiveLanguage();
  const t = useCollectiveText();
  const [access, setAccess] = useState(member.access ?? 'read');
  return (
    <div className="shared-artifact-member-permission">
      <label>
        {label}
        <select
          aria-label={language === 'en' ? `${label}'s work access` : `${label}的作品权限`}
          value={access}
          disabled={disabled}
          onChange={(event) => setAccess(event.target.value as typeof access)}
        >
          <option value="read">{t('查看、批注与请猫修改')}</option>
          <option value="apply">{t('也可采用修改')}</option>
          <option value="revoked">{t('停止访问')}</option>
        </select>
      </label>
      <button type="button" disabled={disabled || access === member.access} onClick={() => onSave(access)}>
        {language === 'en' ? `Update ${label}'s access` : `更新${label}的权限`}
      </button>
    </div>
  );
}
