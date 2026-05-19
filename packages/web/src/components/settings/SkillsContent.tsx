'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { ProjectSelector } from './capability-settings-ui';
import { SettingsStatusStrip } from './primitives';
import { SettingsPageHeader } from './SettingsPageHeader';
import { SkillConflictBanner } from './SkillConflictBanner';
import { SkillPreviewModal } from './SkillPreviewModal';
import {
  HealthStrip,
  SkillRow,
  SkillsEmptyState,
  SkillsFilterToolbar,
  SkillsSummaryFooter,
} from './SkillsSubComponents';
import type { SettingsSkillItem, SkillsApiData, SkillsData } from './skills-types';
import { ALL_CATEGORIES, composeSkillItems, normalizeSearch, normalizeSkillsData } from './skills-types';
import { useSkillControls } from './useSkillControls';

export function SkillsContent() {
  const [data, setData] = useState<SkillsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState(ALL_CATEGORIES);
  const [query, setQuery] = useState('');
  const [previewSkill, setPreviewSkill] = useState<SettingsSkillItem | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [resolving, setResolving] = useState<string | null>(null);
  const [writeError, setWriteError] = useState<string | null>(null);
  const [expandedCats, setExpandedCats] = useState<string | null>(null);

  const controls = useSkillControls();
  const skillsFetchGen = useRef(0);
  const latestProjectRef = useRef(controls.projectPath);
  latestProjectRef.current = controls.projectPath;

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

  const categories = useMemo(() => {
    if (!data) return [ALL_CATEGORIES];
    const seen = new Set<string>();
    for (const skill of data.skills) {
      if (skill.category) seen.add(skill.category);
    }
    return [ALL_CATEGORIES, ...seen];
  }, [data]);

  const filteredSkills = useMemo(() => {
    const needle = normalizeSearch(query);
    return composedItems.filter((skill) => {
      if (activeCategory !== ALL_CATEGORIES && skill.category !== activeCategory) return false;
      if (!needle) return true;
      return `${skill.name} ${skill.category} ${skill.trigger}`.toLowerCase().includes(needle);
    });
  }, [activeCategory, composedItems, query]);

  async function handleSync() {
    setSyncing(true);
    setWriteError(null);
    try {
      const payload: Record<string, unknown> = {};
      if (latestProjectRef.current) payload.projectPath = latestProjectRef.current;
      const res = await apiFetch('/api/skills/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setWriteError(body.error ?? `Sync failed (${res.status})`);
        return;
      }
      await Promise.all([fetchSkills(latestProjectRef.current ?? undefined), controls.refetch()]);
    } catch {
      setWriteError('Sync request failed');
    } finally {
      setSyncing(false);
    }
  }

  async function handleResolveConflict(skillName: string, choice: 'official' | 'mine') {
    setResolving(skillName);
    setWriteError(null);
    try {
      const payload: Record<string, unknown> = { skillName, choice };
      if (latestProjectRef.current) payload.projectPath = latestProjectRef.current;
      const res = await apiFetch('/api/skills/resolve-conflict', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setWriteError(body.error ?? `Resolve failed (${res.status})`);
        return;
      }
      await Promise.all([fetchSkills(latestProjectRef.current ?? undefined), controls.refetch()]);
    } catch {
      setWriteError('Resolve request failed');
    } finally {
      setResolving(null);
    }
  }

  const combinedError = error || controls.error;

  return (
    <div className="space-y-5">
      <SettingsPageHeader title="Skill 管理" subtitle="Skill 注册治理、能力开关和 SKILL.md 预览。" />

      <ProjectSelector
        resolvedPath={controls.resolvedProjectPath}
        knownProjects={controls.knownProjects}
        currentSelection={controls.projectPath}
        onSwitch={(path) => {
          setData(null);
          setActiveCategory(ALL_CATEGORIES);
          setQuery('');
          controls.switchProject(path);
          void fetchSkills(path ?? undefined);
        }}
      />

      {combinedError && <SettingsStatusStrip tone="error">{combinedError}</SettingsStatusStrip>}
      {writeError && <SettingsStatusStrip tone="error">{writeError}</SettingsStatusStrip>}

      {data && (
        <HealthStrip
          summary={data.summary}
          staleness={data.staleness}
          conflictCount={data.conflicts.length}
          syncing={syncing}
          onSync={handleSync}
        />
      )}

      {data && data.conflicts.length > 0 && (
        <SkillConflictBanner conflicts={data.conflicts} resolving={resolving} onResolve={handleResolveConflict} />
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
            catFamilies={controls.catFamilies}
            toggling={controls.toggling}
            expandedCats={expandedCats}
            onPreview={() => setPreviewSkill(skill)}
            onToggle={controls.handleToggle}
            onExpandCats={(id) => setExpandedCats(expandedCats === id ? null : id)}
          />
        ))}
      </div>

      {data && <SkillsSummaryFooter summary={data.summary} />}

      {previewSkill && (
        <SkillPreviewModal
          skillId={previewSkill.name}
          skillName={previewSkill.name}
          description={previewSkill.trigger}
          triggers={previewSkill.trigger ? [previewSkill.trigger] : []}
          category={previewSkill.category}
          projectPath={controls.projectPath}
          onClose={() => setPreviewSkill(null)}
        />
      )}
    </div>
  );
}
