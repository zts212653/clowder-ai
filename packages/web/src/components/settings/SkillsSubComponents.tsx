import { HubIcon } from '../hub-icons';
import { SettingsResourceToggleSwitch } from '../SettingsResourceCard';
import { CapabilityRow } from './capability-settings-ui';
import {
  SettingsBadge,
  SettingsCard,
  SettingsCardSubSection,
  SettingsEmptyState,
  SettingsFilterTabs,
  SettingsIconButton,
  SettingsSearchInput,
  SettingsText,
  SettingsToolbar,
} from './primitives';
import type { SettingsSkillItem, SkillMount, SkillProjectSyncSummary, SkillScope, SkillsData } from './skills-types';
import { MOUNT_POINT_KEYS, SCOPE_ALL, SCOPE_PROJECT } from './skills-types';

export function SkillRow({
  skill,
  scope,
  syncSummary,
  toggling,
  expandedMounts,
  onPreview,
  onToggle,
  onExpandMounts,
  onMountPointToggle,
}: {
  skill: SettingsSkillItem;
  scope: SkillScope;
  syncSummary?: SkillProjectSyncSummary;
  toggling: string | null;
  expandedMounts: string | null;
  onPreview: () => void;
  onToggle: (skill: SettingsSkillItem, enabled: boolean) => void;
  onExpandMounts: (skillId: string) => void;
  onMountPointToggle: (
    skill: SettingsSkillItem,
    mountPointId: string,
    enabled: boolean,
    scope: 'global' | 'project',
  ) => void;
}) {
  const allMounted = skill.governance.allMounted;
  const isGlobalToggling = toggling === skill.id;
  const isMountExpanded = expandedMounts === skill.id;
  const isProject = scope === SCOPE_PROJECT;
  const effectiveEnabled = isProject ? (skill.mountPaths?.length ?? 0) > 0 : (skill.controls?.enabled ?? false);
  const toggleTitle = `${isProject ? '项目' : '全局'}${effectiveEnabled ? '禁用' : '启用'}`;
  const ss = syncSummary;
  const syncLabel = !ss
    ? '同步检测中'
    : ss.status === 'all'
      ? '全部项目一致'
      : ss.status === 'partial'
        ? `部分一致 ${ss.syncedProjects}/${ss.totalProjects}`
        : `待同步 0/${ss.totalProjects}`;
  const syncTone = !ss
    ? 'slate'
    : (({ all: 'emerald', partial: 'amber', none: 'red', unknown: 'slate' } as const)[ss.status] ?? 'slate');

  return (
    <CapabilityRow
      name={skill.name}
      description={skill.description || skill.trigger}
      subInfo={skill.category || '未分类'}
      onClick={onPreview}
      badges={
        scope === SCOPE_ALL ? (
          <SettingsBadge tone={syncTone}>{syncLabel}</SettingsBadge>
        ) : (
          <SettingsBadge tone={allMounted ? 'emerald' : 'amber'}>
            {allMounted ? '全部挂载' : `${skill.governance.mountedCount}/${skill.governance.requiredMountCount} 已挂载`}
          </SettingsBadge>
        )
      }
      actions={
        skill.controls ? (
          <>
            <SettingsResourceToggleSwitch
              enabled={effectiveEnabled}
              busy={isGlobalToggling}
              onClick={(e) => {
                e.stopPropagation();
                onToggle(skill, !effectiveEnabled);
              }}
              title={toggleTitle}
            />
            <SettingsIconButton
              onClick={(e) => {
                e.stopPropagation();
                onExpandMounts(skill.id);
              }}
              title="按挂载规则"
            >
              <HubIcon name="layers" className="h-3.5 w-3.5" />
            </SettingsIconButton>
          </>
        ) : undefined
      }
      expandedContent={
        <>
          {skill.governance.requiresMcp.length > 0 && (
            <div className="flex flex-wrap gap-1.5 pb-3" style={{ paddingInline: '1rem' }}>
              {skill.governance.requiresMcp.map((dep) => (
                <SettingsBadge
                  key={`${skill.id}:${dep.id}`}
                  tone={dep.status === 'ready' ? 'emerald' : dep.status === 'missing' ? 'red' : 'amber'}
                  size="xxs"
                >
                  {dep.id}:{dep.status}
                </SettingsBadge>
              ))}
            </div>
          )}
          {isMountExpanded && skill.controls && (
            <PerMountPointToggles
              skillId={skill.id}
              scope={scope}
              mounts={skill.governance.mounts}
              mountPaths={skill.mountPaths}
              enabledMountPoints={skill.governance.enabledMountPoints}
              toggling={toggling}
              onMountPointToggle={(mountPointId, enabled, toggleScope) =>
                onMountPointToggle(skill, mountPointId, enabled, toggleScope)
              }
            />
          )}
        </>
      }
    />
  );
}

/**
 * F228: Per-mount-point toggles — replaces legacy per-cat toggles.
 *
 * Toggle state = config intent (mountPaths), NOT filesystem reality (mounts).
 * When a mount point is in mountPaths but not actually mounted (e.g. conflict),
 * the toggle stays ON — the anomaly detection banner surfaces the gap.
 */
function PerMountPointToggles({
  skillId,
  scope,
  mounts,
  mountPaths,
  enabledMountPoints,
  toggling,
  onMountPointToggle,
}: {
  skillId: string;
  scope: SkillScope;
  mounts: SkillMount;
  mountPaths?: string[];
  enabledMountPoints: string[];
  toggling: string | null;
  onMountPointToggle: (mountPointId: string, enabled: boolean, scope: 'global' | 'project') => void;
}) {
  const toggleScope = scope === SCOPE_PROJECT ? 'project' : 'global';
  // Config intent: mountPaths lists which mount points the user WANTS mounted.
  // Falls back to filesystem reality (mounts) when mountPaths is unavailable.
  const mountPathSet = mountPaths ? new Set(mountPaths) : null;
  return (
    <SettingsCardSubSection label="挂载规则">
      <div className="mt-1.5 space-y-1">
        {MOUNT_POINT_KEYS.map((mountPointId) => {
          const intended = mountPathSet ? mountPathSet.has(mountPointId) : (mounts[mountPointId] ?? false);
          const actuallyMounted = mounts[mountPointId] ?? false;
          const mountPointEnabled = enabledMountPoints.includes(mountPointId);
          const busy = toggling === `${skillId}:${mountPointId}`;
          const hasConflict = intended && !actuallyMounted;
          return (
            <div key={mountPointId} className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <SettingsText tone={mountPointEnabled ? 'secondary' : 'muted'}>{mountPointId}</SettingsText>
                {!mountPointEnabled && (
                  <SettingsBadge tone="slate" size="xxs">
                    挂载点已禁用
                  </SettingsBadge>
                )}
                {hasConflict && mountPointEnabled && (
                  <SettingsBadge tone="amber" size="xxs">
                    挂载异常
                  </SettingsBadge>
                )}
              </div>
              <SettingsResourceToggleSwitch
                enabled={intended}
                busy={busy}
                onClick={(e) => {
                  e.stopPropagation();
                  onMountPointToggle(mountPointId, !intended, toggleScope);
                }}
                disabled={!mountPointEnabled}
                title={`${intended ? '禁用' : '启用'} ${mountPointId} 挂载`}
                ariaLabel={`${intended ? '禁用' : '启用'} ${mountPointId} 挂载`}
              />
            </div>
          );
        })}
        {enabledMountPoints
          .filter((p) => !(MOUNT_POINT_KEYS as readonly string[]).includes(p))
          .map((customId) => {
            const intended = mountPathSet ? mountPathSet.has(customId) : (mounts[customId] ?? false);
            const actuallyMounted = mounts[customId] ?? false;
            const busy = toggling === `${skillId}:${customId}`;
            const hasConflict = intended && !actuallyMounted;
            return (
              <div key={customId} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <SettingsText tone="secondary">{customId}</SettingsText>
                  <SettingsBadge tone="slate" size="xxs">
                    自定义路径
                  </SettingsBadge>
                  {hasConflict && (
                    <SettingsBadge tone="amber" size="xxs">
                      挂载异常
                    </SettingsBadge>
                  )}
                </div>
                <SettingsResourceToggleSwitch
                  enabled={intended}
                  busy={busy}
                  onClick={(e) => {
                    e.stopPropagation();
                    onMountPointToggle(customId, !intended, toggleScope);
                  }}
                  title={`${intended ? '禁用' : '启用'} ${customId} 挂载`}
                  ariaLabel={`${intended ? '禁用' : '启用'} ${customId} 挂载`}
                />
              </div>
            );
          })}
      </div>
    </SettingsCardSubSection>
  );
}

export function SkillsFilterToolbar({
  categories,
  activeCategory,
  onCategoryChange,
  query,
  onQueryChange,
}: {
  categories: string[];
  activeCategory: string;
  onCategoryChange: (c: string) => void;
  query: string;
  onQueryChange: (q: string) => void;
}) {
  const categoryTabs = categories.map((c) => ({ key: c, label: c }));
  return (
    <SettingsToolbar>
      <SettingsFilterTabs tabs={categoryTabs} activeKey={activeCategory} onTabChange={onCategoryChange} />
      <SettingsSearchInput
        icon={<HubIcon name="search" className="h-3.5 w-3.5" />}
        value={query}
        onChange={onQueryChange}
        placeholder="筛选 Skill"
      />
    </SettingsToolbar>
  );
}

export function SkillsEmptyState() {
  return (
    <SettingsEmptyState
      icon={<HubIcon name="zap" className="mb-3 h-10 w-10 opacity-40" />}
      title="暂无匹配的 Skill"
      description="调整分类或搜索条件后再试。"
    />
  );
}

export function SkillsSummaryFooter({
  summary,
  scope,
  projectCount,
  syncedProjects,
}: {
  summary: SkillsData['summary'];
  scope: SkillScope;
  projectCount: number;
  syncedProjects: number;
}) {
  if (scope === SCOPE_ALL) {
    const status =
      projectCount === 0
        ? '未发现项目'
        : syncedProjects === projectCount
          ? '全部项目一致'
          : syncedProjects > 0
            ? `部分项目一致 ${syncedProjects}/${projectCount}`
            : `待同步 0/${projectCount}`;
    return (
      <SettingsCard>
        <div className="flex items-center gap-4">
          <SettingsText tone="secondary" className="font-semibold">
            {summary.total} skills
          </SettingsText>
          <SettingsText tone={syncedProjects === projectCount && projectCount > 0 ? 'green' : 'amber'}>
            {status}
          </SettingsText>
        </div>
      </SettingsCard>
    );
  }

  return (
    <SettingsCard>
      <div className="flex items-center gap-4">
        <SettingsText tone="secondary" className="font-semibold">
          {summary.total} skills
        </SettingsText>
        <SettingsText tone={summary.allMounted ? 'green' : 'amber'}>
          {summary.allMounted ? '全部正确挂载' : '部分挂载缺失'}
        </SettingsText>
        <SettingsText tone={summary.registrationConsistent ? 'green' : 'amber'}>
          {summary.registrationConsistent ? '注册一致' : '注册不一致'}
        </SettingsText>
      </div>
    </SettingsCard>
  );
}
