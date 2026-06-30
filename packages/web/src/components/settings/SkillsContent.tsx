'use client';

import { useCallback, useMemo, useState } from 'react';
import { SettingsResourceToggleSwitch } from '../SettingsResourceCard';
import { AllProjectsSyncBanner } from './AllProjectsSyncBanner';
import { ProjectSelector, ScopeTabs } from './capability-settings-ui';
import { DriftBanner } from './DriftBanner';
import { MountRulesPanel } from './MountRulesPanel';
import { SettingsStatusStrip } from './primitives';
import { SettingsPageHeader } from './SettingsPageHeader';
import { SkillPreviewModal } from './SkillPreviewModal';
import { SkillRow, SkillsEmptyState, SkillsFilterToolbar, SkillsSummaryFooter } from './SkillsSubComponents';
import type { SettingsSkillItem, SkillScope } from './skills-types';
import {
  ALL_CATEGORIES,
  composeSkillItems,
  matchesSkillSearch,
  normalizeSearch,
  SCOPE_ALL,
  SCOPE_PROJECT,
} from './skills-types';
import { useSkillControls } from './useSkillControls';
import { useSkillsSync } from './useSkillsSync';

export function SkillsContent() {
  const [scope, setScope] = useState<SkillScope>(SCOPE_ALL);
  const [activeCategory, setActiveCategory] = useState(ALL_CATEGORIES);
  const [query, setQuery] = useState('');
  const [previewSkill, setPreviewSkill] = useState<SettingsSkillItem | null>(null);
  const [expandedMounts, setExpandedMounts] = useState<string | null>(null);
  const [driftRefreshToken, setDriftRefreshToken] = useState(0);

  const controls = useSkillControls();
  const refetchControls = controls.refetch;

  // Derive skill list from capabilities (primary source). No /api/skills needed.
  const dataReady = controls.items.length > 0 || !controls.loading;
  const composedItems = useMemo(() => {
    if (!dataReady) return [];
    return composeSkillItems(controls.items, controls.skillHealth);
  }, [dataReady, controls.items, controls.skillHealth]);

  // F228: project scope shows the full skill list (回显完整) so every skill can be
  // managed per-project — not just the ones already mounted.
  const scopeItems = composedItems;

  const selectedProjectPath = controls.projectPath || controls.resolvedProjectPath || undefined;

  const refreshSelectedSkills = useCallback(async () => {
    await refetchControls(selectedProjectPath);
  }, [refetchControls, selectedProjectPath]);

  const refreshMountRulesScopeSkills = useCallback(async () => {
    if (scope === SCOPE_PROJECT) {
      await refreshSelectedSkills();
      return;
    }
    await refetchControls(null);
  }, [refetchControls, refreshSelectedSkills, scope]);

  const handleMountRulesSaved = useCallback(async () => {
    await refreshMountRulesScopeSkills();
    setDriftRefreshToken((value) => value + 1);
  }, [refreshMountRulesScopeSkills]);

  // Unified toggle handler: PATCH capabilities then re-fetch capabilities
  // so the mount display also updates.
  const handleToggle = useCallback(
    async (skill: SettingsSkillItem, enabled: boolean) => {
      await controls.handleToggle(skill.id, enabled, scope === SCOPE_PROJECT ? 'project' : 'global', {
        source: skill.controls?.source ?? skill.source,
        pluginId: skill.pluginId,
      });
      await refetchControls(scope === SCOPE_PROJECT ? selectedProjectPath : undefined);
      setDriftRefreshToken((v) => v + 1);
    },
    [controls, scope, refetchControls, selectedProjectPath],
  );

  const handleMountPointToggle = useCallback(
    async (skill: SettingsSkillItem, mountPointId: string, enabled: boolean, toggleScope: 'global' | 'project') => {
      await controls.handleMountPointToggle(skill.id, mountPointId, enabled, toggleScope, {
        source: skill.controls?.source ?? skill.source,
        pluginId: skill.pluginId,
      });
      await refetchControls(toggleScope === 'project' ? selectedProjectPath : undefined);
      setDriftRefreshToken((v) => v + 1);
    },
    [controls, refetchControls, selectedProjectPath],
  );

  const sync = useSkillsSync({
    scope,
    composedItems,
    controls,
    fetchSkills: refetchControls,
    refreshToken: driftRefreshToken,
  });

  const scopeCounts = useMemo(() => ({ all: composedItems.length, project: composedItems.length }), [composedItems]);

  const categories = useMemo(() => {
    const seen = new Set<string>();
    for (const skill of scopeItems) {
      if (skill.category) seen.add(skill.category);
    }
    return [ALL_CATEGORIES, ...seen];
  }, [scopeItems]);

  const filteredSkills = useMemo(() => {
    const needle = normalizeSearch(query);
    return scopeItems.filter((skill) => {
      if (activeCategory !== ALL_CATEGORIES && skill.category !== activeCategory) return false;
      if (!needle) return true;
      return matchesSkillSearch(skill, needle);
    });
  }, [activeCategory, scopeItems, query]);

  // F228: Batch toggle — enable/disable all currently filtered skills at once.
  // Uses capabilityIds[] so config is written once and syncProject runs once.
  // Placed after filteredSkills to avoid block-scoped variable reference error.
  const handleBatchToggle = useCallback(
    async (enabled: boolean) => {
      const toggleScope = scope === SCOPE_PROJECT ? 'project' : 'global';
      // Only toggle managed cat-cafe skills (those with controls).
      const ids = filteredSkills.filter((s) => s.controls).map((s) => s.id);
      if (ids.length === 0) return;
      await controls.handleBatchToggle(ids, enabled, toggleScope);
      await refetchControls(scope === SCOPE_PROJECT ? selectedProjectPath : undefined);
      setDriftRefreshToken((v) => v + 1);
    },
    [controls, scope, filteredSkills, refetchControls, selectedProjectPath],
  );

  // F228: Compute whether the majority of visible managed skills are enabled
  // to drive the batch toggle's initial state.
  const batchEnabled = useMemo(() => {
    const managed = filteredSkills.filter((s) => s.controls);
    if (managed.length === 0) return false;
    const isProject = scope === SCOPE_PROJECT;
    const enabledCount = managed.filter((s) =>
      isProject ? (s.mountPaths?.length ?? 0) > 0 : (s.controls?.enabled ?? false),
    ).length;
    return enabledCount > managed.length / 2;
  }, [filteredSkills, scope]);

  const combinedError = controls.error;
  return (
    <div className="space-y-5">
      <SettingsPageHeader title="Skill 管理" subtitle="点击卡片预览/编辑" />

      <ScopeTabs
        tabs={[
          { key: SCOPE_ALL, label: '全部 Skill', count: scopeCounts.all },
          { key: SCOPE_PROJECT, label: '项目 Skill', count: scopeCounts.project },
        ]}
        activeKey={scope}
        ariaLabel="Skill scope"
        onTabChange={(key) => {
          const nextScope = key as SkillScope;
          setScope(nextScope);
          setActiveCategory(ALL_CATEGORIES);
          setExpandedMounts(null);
          if (nextScope === SCOPE_ALL) {
            void controls.refetch(null);
          } else {
            // F228: Auto-select first known project when entering project scope.
            // No "全局技能" fallback — the "全部 Skill" tab is the global view.
            const target = selectedProjectPath ?? controls.knownProjects[0] ?? null;
            controls.switchProject(target);
          }
        }}
      />

      {scope === SCOPE_PROJECT && (
        <>
          <ProjectSelector
            resolvedPath={controls.resolvedProjectPath}
            knownProjects={controls.knownProjects}
            currentSelection={controls.projectPath}
            alwaysShow
            onSwitch={(path) => {
              setActiveCategory(ALL_CATEGORIES);
              setQuery('');
              controls.switchProject(path);
            }}
          />
          <MountRulesPanel projectPath={selectedProjectPath} onSaved={handleMountRulesSaved} />
        </>
      )}

      {combinedError && <SettingsStatusStrip tone="error">{combinedError}</SettingsStatusStrip>}

      {scope === SCOPE_ALL && <MountRulesPanel scope="default" onSaved={handleMountRulesSaved} />}

      {dataReady && (
        <SkillsFilterToolbar
          categories={categories}
          activeCategory={activeCategory}
          onCategoryChange={setActiveCategory}
          query={query}
          onQueryChange={setQuery}
        />
      )}

      {dataReady && (
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0 flex-1">
            {scope === SCOPE_ALL && (
              <AllProjectsSyncBanner
                type="skill"
                scopes={sync.scopeIssues}
                scopesWithIssues={sync.scopesWithIssues}
                syncing={sync.syncing}
                error={sync.syncAllError}
                onSyncAll={sync.handleSyncAllScopes}
                onSyncScope={sync.handleSyncScope}
              />
            )}
            {scope === SCOPE_PROJECT && (
              <DriftBanner
                type="skill"
                projectPath={selectedProjectPath}
                refreshToken={driftRefreshToken}
                onResolved={refreshSelectedSkills}
              />
            )}
          </div>
          {filteredSkills.some((s) => s.controls) && (
            <SettingsResourceToggleSwitch
              enabled={batchEnabled}
              busy={controls.toggling === '__batch__'}
              onClick={() => handleBatchToggle(!batchEnabled)}
              title={batchEnabled ? '批量禁用当前筛选的 Skill' : '批量启用当前筛选的 Skill'}
            />
          )}
        </div>
      )}

      {!dataReady && !combinedError && <SettingsStatusStrip tone="muted">加载中...</SettingsStatusStrip>}
      {dataReady && filteredSkills.length === 0 && <SkillsEmptyState />}

      <div className="space-y-3" data-testid="skills-list">
        {filteredSkills.map((skill) => (
          <SkillRow
            key={skill.id}
            skill={skill}
            scope={scope}
            syncSummary={sync.skillProjectSync.get(skill.name)}
            toggling={controls.toggling}
            expandedMounts={expandedMounts}
            onPreview={() => setPreviewSkill(skill)}
            onToggle={handleToggle}
            onExpandMounts={(id) => setExpandedMounts(expandedMounts === id ? null : id)}
            onMountPointToggle={handleMountPointToggle}
          />
        ))}
      </div>

      {dataReady && controls.skillHealth && (
        <SkillsSummaryFooter
          summary={{
            total: composedItems.length,
            allMounted: controls.skillHealth.allMounted,
            registrationConsistent: controls.skillHealth.registrationConsistent,
          }}
          scope={scope}
          projectCount={sync.projectConsistency.totalProjects}
          syncedProjects={sync.projectConsistency.syncedProjects}
        />
      )}

      {previewSkill && (
        <SkillPreviewModal
          skillId={previewSkill.name}
          skillName={previewSkill.name}
          description={previewSkill.description || previewSkill.trigger}
          triggers={previewSkill.trigger ? [previewSkill.trigger] : []}
          category={previewSkill.category}
          projectPath={controls.projectPath}
          onClose={() => setPreviewSkill(null)}
        />
      )}
    </div>
  );
}
