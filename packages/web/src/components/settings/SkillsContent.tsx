'use client';

import { useState } from 'react';
import type { CapabilityBoardItem } from '../capability-board-ui';
import { HubIcon } from '../hub-icons';
import { MarketplacePanel } from '../marketplace/marketplace-panel';
import { PerCatToggles, ProjectSelector, ToggleSwitch } from './capability-settings-ui';
import { SettingsPageHeader } from './SettingsPageHeader';
import { SkillPreviewModal } from './SkillPreviewModal';
import { useCapabilityState } from './useCapabilityState';

export function SkillsContent() {
  const cap = useCapabilityState('skill');
  const [previewItem, setPreviewItem] = useState<CapabilityBoardItem | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="flex gap-5">
      <div className="min-w-0 flex-1 space-y-5">
        <SettingsPageHeader title="Skill 管理" subtitle="点击卡片预览/编辑" />

        <ProjectSelector
          resolvedPath={cap.resolvedProjectPath}
          knownProjects={cap.knownProjects}
          currentSelection={cap.projectPath}
          onSwitch={cap.switchProject}
        />

        {cap.loading && (
          <div className="space-y-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="animate-pulse rounded-xl bg-[var(--console-card-bg)] p-4">
                <div className="h-4 w-1/3 rounded bg-[var(--console-border-soft)]" />
                <div className="mt-2 h-3 w-2/3 rounded bg-[var(--console-border-soft)]" />
              </div>
            ))}
          </div>
        )}

        {!cap.loading && cap.items.length === 0 && (
          <div className="flex flex-col items-center justify-center rounded-2xl bg-[var(--console-card-bg)] px-8 py-16 text-center">
            <HubIcon name="zap" className="mb-3 h-10 w-10 text-cafe-muted opacity-40" />
            <p className="text-[15px] font-semibold text-cafe">暂无已安装的 Skill</p>
            <p className="mt-1 text-xs text-cafe-muted">从右侧市场搜索并安装，或手动新增 Skill</p>
          </div>
        )}

        <div className="space-y-3">
          {cap.items.map((item) => {
            const busy = cap.toggling === item.id;
            const expanded = expandedId === item.id;
            return (
              <div
                key={item.id}
                className="rounded-2xl bg-[var(--console-card-bg)] px-5 py-[18px] shadow-[0_12px_30px_rgba(43,33,26,0.08)] transition-shadow hover:shadow-[0_12px_30px_rgba(43,33,26,0.12)]"
              >
                <div className="flex items-center gap-4">
                  <svg className="h-[18px] w-[18px] shrink-0 text-cafe-muted" viewBox="0 0 24 24" fill="currentColor">
                    <circle cx="9" cy="5" r="1.5" />
                    <circle cx="15" cy="5" r="1.5" />
                    <circle cx="9" cy="12" r="1.5" />
                    <circle cx="15" cy="12" r="1.5" />
                    <circle cx="9" cy="19" r="1.5" />
                    <circle cx="15" cy="19" r="1.5" />
                  </svg>
                  <button
                    type="button"
                    onClick={() => setPreviewItem(item)}
                    className="flex min-w-0 flex-1 items-center gap-4 text-left"
                  >
                    <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[12px] bg-[var(--console-active-bg)] text-sm font-bold text-cafe-interactive">
                      {item.id.charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] font-extrabold text-cafe">{item.id}</p>
                      <p className="mt-0.5 truncate text-xs text-cafe-secondary">{item.description || '—'}</p>
                      {item.category && <p className="mt-0.5 text-[11px] text-cafe-muted">{item.category}</p>}
                    </div>
                  </button>
                  <div className="flex shrink-0 items-center gap-2">
                    {cap.catFamilies.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setExpandedId(expanded ? null : item.id)}
                        className="rounded-md p-1.5 text-cafe-muted hover:bg-[var(--console-card-soft-bg)] hover:text-cafe-secondary transition-colors"
                        title="按猫开关"
                      >
                        <HubIcon name="users" className="h-3.5 w-3.5" />
                      </button>
                    )}
                    <ToggleSwitch
                      enabled={item.enabled}
                      busy={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        cap.handleToggle(item, !item.enabled);
                      }}
                    />
                  </div>
                </div>
                {expanded && (
                  <PerCatToggles
                    item={item}
                    catFamilies={cap.catFamilies}
                    toggling={cap.toggling}
                    onToggle={cap.handleToggle}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <aside className="hidden w-[320px] shrink-0 lg:block">
        <div className="sticky top-0 rounded-2xl bg-[var(--console-card-bg)] p-4 shadow-[0_8px_24px_rgba(43,33,26,0.05)]">
          <h3 className="text-sm font-bold text-cafe">Skill 市场</h3>
          <p className="mt-1 mb-4 text-xs text-cafe-secondary">查询可用 Skill；安装后进入左侧列表。</p>
          <MarketplacePanel />
        </div>
      </aside>

      {previewItem && (
        <SkillPreviewModal
          skillId={previewItem.id}
          skillName={previewItem.id}
          description={previewItem.description}
          triggers={previewItem.triggers}
          category={previewItem.category}
          onClose={() => setPreviewItem(null)}
        />
      )}
    </div>
  );
}
