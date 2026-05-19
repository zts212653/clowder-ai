import type { CatFamily } from '../capability-board-ui';
import { HubIcon } from '../hub-icons';
import {
  SettingsResourceToggleSwitch,
  settingsResourceAvatarClass,
  settingsResourceCardClass,
  settingsResourceRowClass,
} from '../SettingsResourceCard';
import {
  SettingsBadge,
  SettingsCard,
  SettingsCardSubSection,
  SettingsEmptyState,
  SettingsFilterTabs,
  SettingsIconButton,
  SettingsPrimaryButton,
  SettingsSearchInput,
  SettingsStatusStrip,
  SettingsText,
  SettingsToolbar,
} from './primitives';
import type { SettingsSkillItem, SkillsData, SkillsStaleness } from './skills-types';
import { PROVIDER_KEYS } from './skills-types';

export function HealthStrip({
  summary,
  staleness,
  conflictCount,
  syncing,
  onSync,
}: {
  summary: SkillsData['summary'];
  staleness: SkillsStaleness | null;
  conflictCount: number;
  syncing: boolean;
  onSync: () => void;
}) {
  const hasIssues = !summary.allMounted || !summary.registrationConsistent || conflictCount > 0;
  const isStale = staleness?.stale ?? false;

  return (
    <SettingsStatusStrip
      tone={hasIssues ? 'warn' : 'success'}
      bordered
      size="xs"
      actions={
        isStale ? (
          <SettingsPrimaryButton onClick={onSync} disabled={syncing}>
            {syncing ? 'Syncing...' : 'Sync'}
          </SettingsPrimaryButton>
        ) : undefined
      }
    >
      {summary.allMounted ? <SettingsText tone="emerald">挂载正常</SettingsText> : <span>挂载异常</span>}
      <SettingsText tone="muted">·</SettingsText>
      {summary.registrationConsistent ? <SettingsText tone="emerald">注册一致</SettingsText> : <span>注册不一致</span>}
      {conflictCount > 0 && (
        <>
          <SettingsText tone="muted">·</SettingsText>
          <span>{conflictCount} 冲突</span>
        </>
      )}
      {isStale && (
        <>
          <SettingsText tone="muted">·</SettingsText>
          <span className="font-semibold">有更新</span>
          {(staleness?.newSkills.length ?? 0) > 0 && <span>+{staleness?.newSkills.length} 新增</span>}
          {(staleness?.removedSkills.length ?? 0) > 0 && <span>-{staleness?.removedSkills.length} 移除</span>}
        </>
      )}
    </SettingsStatusStrip>
  );
}

export function SkillRow({
  skill,
  catFamilies,
  toggling,
  expandedCats,
  onPreview,
  onToggle,
  onExpandCats,
}: {
  skill: SettingsSkillItem;
  catFamilies: CatFamily[];
  toggling: string | null;
  expandedCats: string | null;
  onPreview: () => void;
  onToggle: (skillId: string, enabled: boolean, catId?: string) => void;
  onExpandCats: (skillId: string) => void;
}) {
  const allMounted = skill.governance.mountedCount === PROVIDER_KEYS.length;
  const isExpanded = expandedCats === skill.id;
  const isGlobalToggling = toggling === skill.id;

  return (
    <div className={settingsResourceCardClass}>
      <div className={settingsResourceRowClass}>
        <button
          type="button"
          onClick={onPreview}
          className="flex min-w-0 flex-1 items-center gap-4"
          style={{ textAlign: 'left' }}
        >
          <div className={settingsResourceAvatarClass}>{skill.name.charAt(0).toUpperCase()}</div>
          <div className="min-w-0 flex-1">
            <SettingsText as="p" variant="sm" tone="default" className="font-bold">
              {skill.name}
            </SettingsText>
            <SettingsText as="p" tone="secondary" className="mt-0.5 truncate">
              {skill.trigger || '—'}
            </SettingsText>
            <SettingsText as="p" tone="muted" className="mt-0.5">
              {skill.category || '未分类'}
            </SettingsText>
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-2">
          <SettingsBadge tone={allMounted ? 'emerald' : 'amber'}>
            {allMounted ? '全部挂载' : `${skill.governance.mountedCount}/${PROVIDER_KEYS.length} 已挂载`}
          </SettingsBadge>
        </div>

        <div className="flex shrink-0 items-center gap-2 pl-2">
          {skill.controls && (
            <>
              <SettingsResourceToggleSwitch
                enabled={skill.controls.enabled}
                busy={isGlobalToggling}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggle(skill.id, !skill.controls?.enabled);
                }}
                title={skill.controls.enabled ? '全局禁用' : '全局启用'}
              />
              {catFamilies.length > 0 && Object.keys(skill.controls.cats).length > 0 && (
                <SettingsIconButton
                  onClick={(e) => {
                    e.stopPropagation();
                    onExpandCats(skill.id);
                  }}
                  title="按猫开关"
                >
                  <HubIcon name={isExpanded ? 'chevron-up' : 'chevron-down'} className="h-3.5 w-3.5" />
                </SettingsIconButton>
              )}
            </>
          )}
        </div>
      </div>

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

      {isExpanded && skill.controls && catFamilies.length > 0 && (
        <PerCatSkillToggles
          skillId={skill.id}
          cats={skill.controls.cats}
          catFamilies={catFamilies}
          toggling={toggling}
          onToggle={onToggle}
        />
      )}
    </div>
  );
}

function PerCatSkillToggles({
  skillId,
  cats,
  catFamilies,
  toggling,
  onToggle,
}: {
  skillId: string;
  cats: Record<string, boolean>;
  catFamilies: CatFamily[];
  toggling: string | null;
  onToggle: (skillId: string, enabled: boolean, catId?: string) => void;
}) {
  return (
    <SettingsCardSubSection label="按猫开关">
      <div className="mt-1.5 space-y-1">
        {catFamilies.map((family) => {
          const relevantCats = family.catIds.filter((catId) => catId in cats);
          if (relevantCats.length === 0) return null;
          return (
            <div key={family.id} className="space-y-1">
              {relevantCats.length > 1 && (
                <SettingsText variant="micro" tone="muted">
                  {family.name}
                </SettingsText>
              )}
              {relevantCats.map((catId) => {
                const enabled = cats[catId] ?? false;
                const busy = toggling === `${skillId}:${catId}`;
                return (
                  <div key={catId} className="flex items-center justify-between">
                    <SettingsText tone="secondary">{catId}</SettingsText>
                    <SettingsResourceToggleSwitch
                      enabled={enabled}
                      busy={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggle(skillId, !enabled, catId);
                      }}
                    />
                  </div>
                );
              })}
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
  const tabs = categories.map((c) => ({ key: c, label: c }));
  return (
    <SettingsToolbar>
      <SettingsFilterTabs tabs={tabs} activeKey={activeCategory} onTabChange={onCategoryChange} />
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

export function SkillsSummaryFooter({ summary }: { summary: SkillsData['summary'] }) {
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
