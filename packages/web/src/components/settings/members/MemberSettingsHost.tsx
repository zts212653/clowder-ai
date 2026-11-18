'use client';
import { useEffect, useState } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { apiFetch } from '@/utils/api-client';
import type { MemberSaveTrace } from '@/utils/member-save-trace';
import { CatOverviewTab, type ConfigData } from '../../config-viewer-tabs';
import { MemberCopyProvider } from '../../members/editor-presentation';
import { MemberListHost } from '../../members/MemberListHost';
import { useMemberReturn } from '../../members/useMemberReturn';
import { useShellLanguage } from '../../shell/shell-language';
import { OpenTeamWorkspaceButton } from '../OpenTeamWorkspaceButton';
import { MemberCreationPage } from './MemberCreationPage';
import { MemberSettingsPage } from './MemberSettingsPage';

type BudgetAudit = { referenceTokens: number; members: { catId: string; tokens: number }[] };
type BudgetState = BudgetAudit | 'loading' | 'error';

function formatBudgetNotice(budget: BudgetAudit, english: boolean): string {
  const longest = budget.members[0];
  if (!longest)
    return english ? 'No available members to estimate a fixed prompt for.' : '当前没有可用成员可供固定提示词估算。';
  return english
    ? `Estimated L0 fixed prompt for ${budget.members.length} available members: longest @${longest.catId} is ${longest.tokens} tokens (historical reference ${budget.referenceTokens}, not a model limit; includes your profile).`
    : `当前 ${budget.members.length} 位可用成员，固定提示词（L0）估算最长 @${longest.catId}：${longest.tokens} tokens（历史参考 ${budget.referenceTokens}，不是模型上限；含当前用户画像）。`;
}

function formatBudgetState(budget: BudgetState, english: boolean): string {
  if (budget === 'loading') return english ? 'Estimating fixed prompts…' : '正在估算固定提示词…';
  if (budget === 'error') return english ? 'Fixed prompt estimate is unavailable.' : '固定提示词估算暂不可用。';
  return formatBudgetNotice(budget, english);
}

export function MemberSettingsHost({
  v2,
  editorOpen,
  editingCat,
  cats,
  config,
  configError,
  registryLoading,
  registryKnown,
  creationView,
  onRetryConfig,
  onRetryRegistry,
  onOpen,
  onDetect,
  onClose,
  onSaved,
  onTeamCreated,
  onEditCoCreator,
  onDelete,
  onToggle,
  togglingCatId,
}: {
  v2: boolean;
  editorOpen: boolean;
  editingCat: CatData | null;
  cats: CatData[];
  config: ConfigData | null;
  configError: string | null;
  registryLoading: boolean;
  registryKnown: boolean;
  creationView: string | null;
  onRetryConfig: () => void;
  onRetryRegistry: () => void;
  onOpen: (cat: CatData | null) => void;
  onDetect?: () => void;
  onClose: () => void;
  onSaved: (cat: CatData, trace?: MemberSaveTrace) => Promise<void>;
  onTeamCreated: () => Promise<void>;
  onEditCoCreator: () => void;
  onDelete: (cat: CatData) => Promise<boolean>;
  onToggle: (cat: CatData) => void;
  togglingCatId: string | null;
}) {
  const returnToList = useMemberReturn();
  const english = useShellLanguage() === 'en';
  const [budget, setBudget] = useState<BudgetState>('loading');
  const [budgetRevision, setBudgetRevision] = useState(0);
  const memberRevisions = JSON.stringify(cats.map((cat) => [cat.id, cat.roster?.available, cat.configurationRevision]));
  const budgetNotice = formatBudgetState(budget, english);
  // biome-ignore lint/correctness/useExhaustiveDependencies: roster and saves are the audit's refresh triggers.
  useEffect(() => {
    let current = true;
    setBudget('loading');
    apiFetch('/api/cats/l0-budget')
      .then(async (response) => {
        if (!response.ok) throw new Error('audit unavailable');
        return (await response.json()) as BudgetAudit;
      })
      .then((result) => {
        if (!Array.isArray(result.members) || typeof result.referenceTokens !== 'number') throw new Error('bad audit');
        if (current) setBudget(result);
      })
      .catch(() => {
        if (current) setBudget('error');
      });
    return () => {
      current = false;
    };
  }, [memberRevisions, budgetRevision]);
  const saved = async (cat: CatData, trace?: MemberSaveTrace) => {
    try {
      await onSaved(cat, trace);
    } finally {
      setBudgetRevision((revision) => revision + 1);
    }
  };
  const open = (cat: CatData | null) => {
    returnToList.remember();
    onOpen(cat);
  };
  const detect = () => {
    returnToList.remember();
    onDetect?.();
  };
  const close = () => {
    onClose();
    returnToList.restore();
  };
  return (
    <MemberCopyProvider>
      <div ref={returnToList.host}>
        {!editorOpen && budgetNotice && (
          <output className="mb-4 block text-sm text-cafe-text-muted">{budgetNotice}</output>
        )}
        {config && configError && (
          <p role="alert" className="mb-4 rounded-xl bg-conn-red-bg p-4 text-sm text-conn-red-text">
            {configError}
          </p>
        )}
        {v2 ? (
          <MemberListHost
            hidden={editorOpen}
            registryLoading={registryLoading}
            registryKnown={registryKnown}
            onRetryRegistry={onRetryRegistry}
            config={config}
            configError={configError}
            onRetryConfig={onRetryConfig}
            cats={cats}
            onAdd={() => open(null)}
            onDetect={detect}
            onEdit={open}
            onEditCoCreator={onEditCoCreator}
            onToggle={onToggle}
            togglingCatId={togglingCatId}
          />
        ) : (
          <div hidden={editorOpen} className="space-y-8">
            {configError ? (
              <p role="alert">{configError}</p>
            ) : config ? (
              <CatOverviewTab
                config={config}
                cats={cats}
                onEditMember={open}
                onEditCoCreator={onEditCoCreator}
                onDeleteMember={onDelete}
                onToggleAvailability={onToggle}
                togglingCatId={togglingCatId}
              />
            ) : (
              <p role="status">加载中...</p>
            )}
            <div className="space-y-3">
              <div className="flex justify-end">
                <OpenTeamWorkspaceButton />
              </div>
            </div>
          </div>
        )}
        {editorOpen &&
          (editingCat ? (
            <MemberSettingsPage
              key={editingCat.id}
              cat={editingCat}
              cats={cats}
              onBack={close}
              onSaved={saved}
              budgetNotice={budgetNotice}
              onDelete={async () => {
                if (await onDelete(editingCat)) close();
              }}
            />
          ) : (
            <MemberCreationPage
              key={creationView}
              cats={cats}
              budgetNotice={budgetNotice}
              onBack={close}
              onTeamCreated={async () => {
                await onTeamCreated();
                setBudgetRevision((revision) => revision + 1);
                close();
              }}
              onSaved={async (cat, trace) => {
                await saved(cat, trace);
                close();
              }}
            />
          ))}
      </div>
    </MemberCopyProvider>
  );
}
