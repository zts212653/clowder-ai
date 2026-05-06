'use client';

import { DependencyGraphTab } from './DependencyGraphTab';
import { ExternalProjectTab } from './ExternalProjectTab';
import { FeatureRowList } from './FeatureRowList';
import { ImportProjectModal } from './ImportProjectModal';
import { QuickCreateForm } from './QuickCreateForm';
import { SuggestionDrawer } from './SuggestionDrawer';
import { ThreadSituationPanel } from './ThreadSituationPanel';
import type { RightPanelTab } from './useMissionHubData';
import { useMissionHubData } from './useMissionHubData';
import { WorkflowSopPanel } from './WorkflowSopPanel';

function StatusDot({ color, label, textColor }: { color: string; label: string; textColor: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${color}`} />
      <span className={`text-[13px] font-semibold ${textColor}`}>{label}</span>
    </span>
  );
}

const TAB_BASE = 'px-4 py-2 text-[13px] font-semibold transition-colors rounded-lg';
const TAB_ACTIVE = `${TAB_BASE} bg-[var(--console-active-bg)] text-cafe`;
const TAB_IDLE = `${TAB_BASE} text-cafe-muted hover:text-cafe-secondary`;

const RIGHT_TAB_BASE = 'px-3 py-1.5 text-xs font-medium transition-colors';
const RIGHT_TAB_ACTIVE = `${RIGHT_TAB_BASE} border-b-2 border-[var(--cafe-accent)] text-cafe`;
const RIGHT_TAB_IDLE = `${RIGHT_TAB_BASE} text-cafe-muted hover:text-cafe-secondary`;

function TabButton({
  active,
  onClick,
  label,
  testId,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  testId?: string;
}) {
  return (
    <button type="button" onClick={onClick} className={active ? TAB_ACTIVE : TAB_IDLE} data-testid={testId}>
      {label}
    </button>
  );
}

function RightTabButton({
  tab,
  current,
  onClick,
  label,
  testId,
}: {
  tab: RightPanelTab;
  current: RightPanelTab;
  onClick: (t: RightPanelTab) => void;
  label: string;
  testId?: string;
}) {
  return (
    <button
      type="button"
      className={tab === current ? RIGHT_TAB_ACTIVE : RIGHT_TAB_IDLE}
      onClick={() => onClick(tab)}
      data-testid={testId}
    >
      {label}
    </button>
  );
}

export function MissionHubView() {
  const d = useMissionHubData();

  return (
    <div className="flex h-full flex-col bg-[var(--console-panel-bg)]">
      <div className="flex flex-1 flex-col overflow-hidden rounded-[18px] bg-[var(--console-shell-bg)] shadow-[var(--console-shadow-soft)] m-3">
        {/* Header */}
        <header className="flex items-center justify-between px-7 py-4">
          <h1 className="text-lg font-bold text-cafe">Mission Hub</h1>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => void d.handleImportFromDocs()}
              disabled={d.submitting}
              className="console-button-secondary disabled:opacity-40"
              data-testid="mc-import-docs"
            >
              导入 Backlog
            </button>
            <button
              type="button"
              onClick={() => d.setShowImportModal(true)}
              className="console-button-secondary"
              data-testid="mc-import-project"
            >
              + 导入项目
            </button>
          </div>
        </header>

        {d.showImportModal && (
          <ImportProjectModal
            onClose={() => d.setShowImportModal(false)}
            onImported={() => void d.handleImportFromDocs()}
          />
        )}

        {/* Tabs + Status */}
        <div className="flex items-center justify-between px-7 py-2.5">
          <div className="flex items-center gap-1">
            <TabButton
              active={d.activeTab === 'features'}
              onClick={() => d.setActiveTab('features')}
              label="功能列表"
              testId="mc-tab-features"
            />
            <TabButton
              active={d.activeTab === 'dependencies'}
              onClick={() => d.setActiveTab('dependencies')}
              label="依赖全景"
              testId="mc-tab-dependencies"
            />
            {d.projects.map((p) => (
              <TabButton key={p.id} active={d.activeTab === p.id} onClick={() => d.setActiveTab(p.id)} label={p.name} />
            ))}
          </div>
          <div className="flex items-center gap-4">
            <StatusDot color="bg-conn-amber-text" label={`${d.pendingCount} 待审批`} textColor="text-conn-amber-text" />
            <StatusDot color="bg-conn-blue-text" label={`${d.activeCount} 执行中`} textColor="text-conn-blue-text" />
            <StatusDot
              color="bg-conn-emerald-text"
              label={`${d.doneCount} 已完成`}
              textColor="text-conn-emerald-text"
            />
          </div>
        </div>

        {d.error && (
          <div
            className="mx-7 mt-3 rounded-xl border border-conn-red-ring bg-conn-red-bg px-3 py-2 text-xs text-conn-red-text"
            role="alert"
            data-testid="mc-error"
          >
            {d.error}
          </div>
        )}

        {/* Main content */}
        <div className="min-h-0 flex-1 overflow-auto">
          {d.activeProject ? (
            <div className="p-6">
              <ExternalProjectTab project={d.activeProject} />
            </div>
          ) : d.activeTab === 'features' ? (
            <div className="grid min-h-0 grid-cols-1 gap-4 p-6 xl:grid-cols-[minmax(0,1fr)_340px]">
              <div className="space-y-4">
                <QuickCreateForm disabled={d.submitting} onCreate={d.handleCreate} />
                <FeatureRowList
                  items={d.items}
                  threadsByBacklogId={d.threadsByBacklogId}
                  threadCountByFeature={d.threadCountByFeature}
                  threadsByFeatureId={d.threadsByFeatureId}
                  selectedItemId={d.selectedItemId}
                  onSelectItem={d.setSelectedItemId}
                  onDeleteItem={d.handleDelete}
                />
              </div>
              {/* Right panel */}
              <div className="flex min-h-0 flex-col rounded-2xl bg-[var(--console-card-bg)] shadow-[0_12px_30px_rgba(43,33,26,0.08)]">
                <div className="flex border-b border-[var(--console-border-soft)] px-3 pt-2">
                  <RightTabButton
                    tab="suggestion"
                    current={d.rightPanelTab}
                    onClick={d.setRightPanelTab}
                    label="建议详情"
                    testId="mc-right-tab-suggestion"
                  />
                  <RightTabButton
                    tab="sop"
                    current={d.rightPanelTab}
                    onClick={d.setRightPanelTab}
                    label="SOP"
                    testId="mc-right-tab-sop"
                  />
                  <RightTabButton
                    tab="threads"
                    current={d.rightPanelTab}
                    onClick={d.setRightPanelTab}
                    label="线程态势"
                    testId="mc-right-tab-threads"
                  />
                </div>
                <div className="flex-1 overflow-auto">
                  {d.rightPanelTab === 'suggestion' && (
                    <SuggestionDrawer
                      item={d.selectedItem}
                      submitting={d.submitting}
                      selectedPhase={d.selectedPhase}
                      selfClaimScopes={d.selfClaimScopes}
                      selfClaimPolicyBlocker={d.selfClaimPolicyBlocker}
                      onChangePhase={d.setSelectedPhase}
                      onSuggest={d.handleSuggest}
                      onApprove={d.handleApprove}
                      onReject={d.handleReject}
                      onSelfClaim={d.handleSelfClaim}
                      onAcquireLease={d.handleAcquireLease}
                      onHeartbeatLease={d.handleHeartbeatLease}
                      onReleaseLease={d.handleReleaseLease}
                      onReclaimLease={d.handleReclaimLease}
                    />
                  )}
                  {d.rightPanelTab === 'sop' && <WorkflowSopPanel backlogItemId={d.selectedItemId} />}
                  {d.rightPanelTab === 'threads' && (
                    <ThreadSituationPanel
                      dispatchedItems={d.dispatchedItems}
                      loading={d.threadsLoading}
                      threadsByBacklogId={d.threadsByBacklogId}
                      threadsByFeatureId={d.threadsByFeatureId}
                    />
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="p-6">
              <DependencyGraphTab items={d.items} />
            </div>
          )}
        </div>

        {d.loading && d.items.length === 0 && <p className="px-7 py-2 text-xs text-cafe-muted">加载 backlog 中...</p>}
      </div>
    </div>
  );
}
