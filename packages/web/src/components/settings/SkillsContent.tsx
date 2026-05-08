'use client';

import { useState } from 'react';
import type { CapabilityBoardItem } from '../capability-board-ui';
import { HubIcon } from '../hub-icons';
import {
  SettingsResourceIconButton,
  settingsResourceActionGroupClass,
  settingsResourceAvatarClass,
  settingsResourceCardClass,
  settingsResourceRowClass,
} from '../SettingsResourceCard';
import { PerCatToggles, ProjectSelector, ToggleSwitch } from './capability-settings-ui';
import { SettingsPageHeader } from './SettingsPageHeader';
import { SkillPreviewModal } from './SkillPreviewModal';
import { useCapabilityState } from './useCapabilityState';

export function SkillsContent() {
  const cap = useCapabilityState('skill');
  const [previewItem, setPreviewItem] = useState<CapabilityBoardItem | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="space-y-5">
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
          <p className="mt-1 text-xs text-cafe-muted">Skill 在 cat-cafe-skills/ 目录下管理，或通过 CLI 安装</p>
        </div>
      )}

      <div className="space-y-3">
        {cap.items.map((item) => {
          const busy = cap.toggling === item.id;
          const expanded = expandedId === item.id;
          return (
            <div key={item.id} className={settingsResourceCardClass}>
              <div className={settingsResourceRowClass}>
                <svg
                  className="h-[18px] w-[18px] shrink-0 text-cafe-muted"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                  aria-hidden="true"
                >
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
                  <div className={settingsResourceAvatarClass}>{item.id.charAt(0).toUpperCase()}</div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-bold text-cafe">{item.id}</p>
                    <p className="mt-0.5 truncate text-xs text-cafe-secondary">{item.description || '—'}</p>
                    {item.category && <p className="mt-0.5 text-label text-cafe-muted">{item.category}</p>}
                  </div>
                </button>
                <div className={settingsResourceActionGroupClass}>
                  {cap.catFamilies.length > 0 && (
                    <SettingsResourceIconButton
                      onClick={() => setExpandedId(expanded ? null : item.id)}
                      title="按猫开关"
                      aria-label="按猫开关"
                    >
                      <HubIcon name="users" className="h-4 w-4" />
                    </SettingsResourceIconButton>
                  )}
                  <ToggleSwitch
                    enabled={item.enabled}
                    busy={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      cap.handleToggle(item, !item.enabled);
                    }}
                  />
                  {item.source === 'external' && (
                    <SettingsResourceIconButton
                      onClick={(e) => {
                        e.stopPropagation();
                        cap.handleDisableSkill(item);
                      }}
                      title="卸载 Skill"
                      aria-label="卸载 Skill"
                      tone="danger"
                    >
                      <HubIcon name="trash" className="h-4 w-4" />
                    </SettingsResourceIconButton>
                  )}
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

      {previewItem && (
        <SkillPreviewModal
          skillId={previewItem.id}
          skillName={previewItem.id}
          description={previewItem.description}
          triggers={previewItem.triggers}
          category={previewItem.category}
          projectPath={cap.projectPath}
          onClose={() => setPreviewItem(null)}
        />
      )}
    </div>
  );
}
