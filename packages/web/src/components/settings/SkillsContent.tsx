'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { AllProjectsSyncBanner } from './AllProjectsSyncBanner';
import { ProjectSelector } from './capability-settings-ui';
import { MountRulesPanel } from './MountRulesPanel';
import { SettingsStatusStrip } from './primitives';
import { SettingsPageHeader } from './SettingsPageHeader';
import { SkillPreviewModal } from './SkillPreviewModal';
import { SkillsDriftBanner } from './SkillsDriftBanner';
import {
  SkillRow,
  SkillsEmptyState,
  SkillsFilterToolbar,
  SkillsScopeTabs,
  SkillsSummaryFooter,
} from './SkillsSubComponents';
import type { SettingsSkillItem, SkillScope, SkillsApiData, SkillsData } from './skills-types';
import {
  ALL_CATEGORIES,
  composeSkillItems,
  isSkillVisibleInProjectScope,
  matchesSkillSearch,
  normalizeSearch,
  normalizeSkillsData,
  SCOPE_ALL,
  SCOPE_PROJECT,
} from './skills-types';
import { useSkillControls } from './useSkillControls';
import { useSkillsSync } from './useSkillsSync';

export function SkillsContent() {
  const [data, setData] = useState<SkillsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<SkillScope>(SCOPE_ALL);
  const [activeCategory, setActiveCategory] = useState(ALL_CATEGORIES);
  const [query, setQuery] = useState('');
  const [previewSkill, setPreviewSkill] = useState<SettingsSkillItem | null>(null);
  const [expandedMounts, setExpandedMounts] = useState<string | null>(null);
  const [driftRefreshToken, setDriftRefreshToken] = useState(0);

  const controls = useSkillControls();
  const refetchControls = controls.refetch;
  const skillsFetchGen = useRef(0);

  const fetchSkills = useCallback(async (forProject?: string) => {
    const generation = ++skillsFetchGen.current;
    const isCurrent = () => skillsFetchGen.current === generation;
    setError(null);
    try {
      const q = forProject ? `?projectPath=${encodeURIComponent(forProject)}` : '';
      const res = await apiFetch(`/api/skills${q}`);
      if (!isCurrent()) return;
      if (!res.ok) {
        setError(`Skills 数据加载失败 (${res.status})`);
        return;
      }
      const parsed = normalizeSkillsData((await res.json()) as SkillsApiData);
      if (!isCurrent()) return;
      setData(parsed);
    } catch {
      if (!isCurrent()) return;
      setError('Skills 数据加载失败');
    }
  }, []);

  useEffect(() => {
    void fetchSkills();
  }, [fetchSkills]);

  const composedItems = useMemo(() => {
    if (!data) return [];
    return composeSkillItems(data, controls.items);
  }, [data, controls.items]);

  const projectScopeItems = useMemo(
    () => composedItems.filter((skill) => isSkillVisibleInProjectScope(skill)),
    [composedItems],
  );

  const scopeItems = scope === SCOPE_PROJECT ? projectScopeItems : composedItems;

  const selectedProjectPath = controls.projectPath || controls.resolvedProjectPath || undefined;

  const refreshSelectedSkills = useCallback(async () => {
    await Promise.all([fetchSkills(selectedProjectPath), refetchControls(selectedProjectPath)]);
  }, [fetchSkills, refetchControls, selectedProjectPath]);

  const refreshMountRulesScopeSkills = useCallback(async () => {
    if (scope === SCOPE_PROJECT) {
      await refreshSelectedSkills();
      return;
    }
    await Promise.all([fetchSkills(), refetchControls(null)]);
  }, [fetchSkills, refetchControls, refreshSelectedSkills, scope]);

  const handleMountRulesSaved = useCallback(async () => {
    await refreshMountRulesScopeSkills();
    setDriftRefreshToken((value) => value + 1);
  }, [refreshMountRulesScopeSkills]);

  // Unified toggle handler: PATCH capabilities then re-fetch BOTH capabilities AND skills
  // so the mount display (from /api/skills) also updates.
  const handleToggle = useCallback(
    async (skill: SettingsSkillItem, enabled: boolean) => {
      await controls.handleToggle(skill.id, enabled, scope === SCOPE_PROJECT ? 'project' : 'global', {
        source: skill.controls?.source ?? skill.source,
        pluginId: skill.pluginId,
      });
      // Re-fetch skills data so mount state reflects the filesystem changes.
      await fetchSkills(scope === SCOPE_PROJECT ? selectedProjectPath : undefined);
    },
    [controls, scope, fetchSkills, selectedProjectPath],
  );

  const handleProviderToggle = useCallback(
    async (skill: SettingsSkillItem, providerId: string, enabled: boolean, toggleScope: 'global' | 'project') => {
      await controls.handleProviderToggle(skill.id, providerId, enabled, toggleScope, {
        source: skill.controls?.source ?? skill.source,
        pluginId: skill.pluginId,
      });
      await fetchSkills(toggleScope === 'project' ? selectedProjectPath : undefined);
    },
    [controls, fetchSkills, selectedProjectPath],
  );

  const sync = useSkillsSync({ scope, data, composedItems, controls, fetchSkills });

  const scopeCounts = useMemo(
    () => ({ all: composedItems.length, project: projectScopeItems.length }),
    [composedItems, projectScopeItems],
  );

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

  const combinedError = error || controls.error;
  return (
    <div className="space-y-5">
      <SettingsPageHeader title="Skill 管理" subtitle="点击卡片预览/编辑" />

      <SkillsScopeTabs
        scope={scope}
        onScopeChange={(nextScope) => {
          setScope(nextScope);
          setActiveCategory(ALL_CATEGORIES);
          setExpandedMounts(null);
          if (nextScope === SCOPE_ALL) {
            void fetchSkills();
            void controls.refetch(null);
          } else {
            setData(null);
            void fetchSkills(selectedProjectPath);
            void controls.refetch(selectedProjectPath);
          }
        }}
        allCount={scopeCounts.all}
        projectCount={scopeCounts.project}
      />

      {scope === SCOPE_PROJECT && (
        <>
          <ProjectSelector
            resolvedPath={controls.resolvedProjectPath}
            knownProjects={controls.knownProjects}
            currentSelection={controls.projectPath}
            alwaysShow
            onSwitch={(path) => {
              setData(null);
              setActiveCategory(ALL_CATEGORIES);
              setQuery('');
              controls.switchProject(path);
              void fetchSkills(path ?? undefined);
            }}
          />
          <MountRulesPanel projectPath={selectedProjectPath} onSaved={handleMountRulesSaved} />
          <SkillsDriftBanner
            projectPath={selectedProjectPath}
            summary={data?.summary}
            staleness={data?.staleness}
            refreshToken={driftRefreshToken}
            onResolved={refreshSelectedSkills}
          />
        </>
      )}

      {combinedError && <SettingsStatusStrip tone="error">{combinedError}</SettingsStatusStrip>}

      {scope === SCOPE_ALL && <MountRulesPanel scope="default" onSaved={handleMountRulesSaved} />}

      {scope === SCOPE_ALL && data && (
        <AllProjectsSyncBanner
          projectCount={sync.projectConsistency.totalProjects}
          syncedProjects={sync.projectConsistency.syncedProjects}
          syncing={sync.syncing}
          error={sync.syncAllError}
          onSyncAll={sync.handleSyncAllProjects}
          projectDetails={sync.projectSyncDetails}
          onSyncProject={sync.handleSyncSingleProject}
        />
      )}

      {data && (
        <SkillsFilterToolbar
          categories={categories}
          activeCategory={activeCategory}
          onCategoryChange={setActiveCategory}
          query={query}
          onQueryChange={setQuery}
        />
      )}

      {!data && !error && <SettingsStatusStrip tone="muted">加载中...</SettingsStatusStrip>}
      {data && filteredSkills.length === 0 && <SkillsEmptyState />}

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
            onProviderToggle={handleProviderToggle}
          />
        ))}
      </div>

      {data && (
        <SkillsSummaryFooter
          summary={data.summary}
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
