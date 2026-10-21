'use client';

import type { CatData } from '@/hooks/useCatData';
import type { ConfigData } from '../config-viewer-types';
import { useMemberText } from './editor-presentation';
import { MemberListPage } from './MemberListPage';
export function MemberListHost({
  hidden,
  registryLoading,
  registryKnown,
  onRetryRegistry,
  config,
  configError,
  onRetryConfig,
  cats,
  onAdd,
  onDetect,
  onEdit,
  onEditCoCreator,
  onToggle,
  togglingCatId,
}: {
  hidden: boolean;
  registryLoading: boolean;
  registryKnown: boolean;
  onRetryRegistry: () => void;
  config: ConfigData | null;
  configError?: string | null;
  onRetryConfig?: () => void;
  cats: CatData[];
  onAdd: () => void;
  onDetect?: () => void;
  onEdit: (cat: CatData) => void;
  onEditCoCreator: () => void;
  onToggle: (cat: CatData) => void;
  togglingCatId: string | null;
}) {
  const t = useMemberText();
  return (
    <div hidden={hidden}>
      {config ? (
        <MemberListPage
          registryLoading={registryLoading}
          registryKnown={registryKnown}
          onRetryRegistry={onRetryRegistry}
          config={config}
          cats={cats}
          onAddMember={onAdd}
          onDetectMembers={onDetect}
          onEditMember={onEdit}
          onEditCoCreator={onEditCoCreator}
          onToggleAvailability={onToggle}
          togglingCatId={togglingCatId}
        />
      ) : configError ? (
        <p role="alert">
          {t('读取失败')}{' '}
          <button type="button" className="member-button" onClick={onRetryConfig}>
            {t('重试')}
          </button>
        </p>
      ) : (
        <p>{t('正在读取成员配置…')}</p>
      )}
    </div>
  );
}
