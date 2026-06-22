'use client';

/**
 * F208 Phase C+D: Cat Dossier — Model-grouped capability profiles page.
 *
 * KD-15: 画像单位 = model（认知能力），catId 是索引便利。
 * 数据来自 GET /api/dossier + GET /api/dossier/observations（split endpoints）。
 *
 * Phase C: L1 结构化字段 read-only 展示。
 * Phase D: operator 观察入口（AC-D1）+ 最近证据展示（AC-D2）。
 * OQ-10: Phase D = staging + read；promotion 留 Phase E。
 */

import { useCallback, useState } from 'react';
import { type EvidenceSnippet, useDossierEvidence } from '@/hooks/useDossierEvidence';
import { type DossierObservation, useDossierObservations } from '@/hooks/useDossierObservations';
import {
  type DossierCatEntry,
  type DossierModelGroup,
  type DossierProfileData,
  type DossierProvenance,
  useDossierProfiles,
} from '@/hooks/useDossierProfiles';
import {
  SettingsBadge,
  SettingsCard,
  SettingsCollapsibleCard,
  SettingsEmptyState,
  SettingsSection,
  SettingsText,
} from './primitives';
import { SettingsPageHeader } from './SettingsPageHeader';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Human-readable model name — strip vendor prefix for display. */
export function formatModelName(model: string): string {
  if (!model || model === 'unknown') return '未知模型';
  // e.g. "claude-opus-4-6" → "Claude Opus 4.6", "claude-fable-5" → "Claude Fable 5"
  if (model.startsWith('claude-')) {
    const parts = model.replace('claude-', '').split('-');
    // Find where the version starts (first segment beginning with a digit)
    const versionStart = parts.findIndex((p) => /^\d/.test(p));
    if (versionStart > 0) {
      const name = parts
        .slice(0, versionStart)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      const ver = parts.slice(versionStart).join('.');
      return `Claude ${name} ${ver}`;
    }
    // No numeric segment found — capitalize all parts
    return `Claude ${parts.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}`;
  }
  if (model.startsWith('gpt-')) {
    return `GPT ${model.replace('gpt-', '')}`;
  }
  if (model.startsWith('gemini-')) {
    return model
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  }
  return model;
}

/** Family → badge tone mapping. */
function familyTone(family?: string): 'purple' | 'blue' | 'amber' | 'emerald' | 'slate' {
  switch (family) {
    case 'ragdoll':
      return 'purple';
    case 'maine-coon':
      return 'blue';
    case 'siamese':
      return 'amber';
    case 'bengal':
      return 'emerald';
    default:
      return 'slate';
  }
}

/** Family → display name. */
function familyLabel(family?: string): string {
  switch (family) {
    case 'ragdoll':
      return '布偶猫';
    case 'maine-coon':
      return '缅因猫';
    case 'siamese':
      return '暹罗猫';
    case 'bengal':
      return '孟加拉猫';
    default:
      return family ?? '未知';
  }
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ProvenanceBadge({ provenance }: { provenance?: DossierProvenance }) {
  if (!provenance) return null;
  const sources = provenance.primarySources?.join(', ') ?? '';
  const label = `v${provenance.version} · ${provenance.date}${sources ? ` · ${sources}` : ''}`;
  return (
    <SettingsBadge tone="slate" size="xxs" title="画像来源与版本">
      {label}
    </SettingsBadge>
  );
}

function SignalTags({ signals, tone }: { signals: string[]; tone: 'emerald' | 'amber' }) {
  if (signals.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {signals.map((s) => (
        <SettingsBadge key={s} tone={tone} size="xxs">
          {s}
        </SettingsBadge>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase D: Observation form (AC-D1)
// ---------------------------------------------------------------------------

function ObservationForm({
  catId,
  onSubmit,
}: {
  catId: string;
  onSubmit: (catId: string, content: string) => Promise<DossierObservation | null>;
}) {
  const [open, setOpen] = useState(false);
  const [content, setContent] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (!content.trim() || submitting) return;
    setSubmitting(true);
    const result = await onSubmit(catId, content.trim());
    if (result) {
      setContent('');
      setOpen(false);
    }
    setSubmitting(false);
  }, [catId, content, onSubmit, submitting]);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-cafe-secondary transition-colors hover:text-cafe"
      >
        + 添加观察
      </button>
    );
  }

  return (
    <div className="mt-2 space-y-2">
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        placeholder="记录对这只猫的体感观察..."
        className="w-full rounded-md border border-[var(--console-border-soft)] bg-[var(--console-bg)] px-3 py-2 text-xs text-[var(--console-text)] placeholder:text-[var(--console-text-muted)] focus:border-[var(--cafe-accent)] focus:outline-none"
        rows={2}
      />
      <div className="flex gap-2">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!content.trim() || submitting}
          className="rounded px-3 py-1 text-xs font-medium text-white transition-colors bg-[var(--cafe-accent)] hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? '提交中...' : '提交'}
        </button>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setContent('');
          }}
          className="rounded px-3 py-1 text-xs text-[var(--console-text-muted)] transition-colors hover:text-[var(--console-text)]"
        >
          取消
        </button>
      </div>
    </div>
  );
}

function ObservationList({ observations }: { observations: DossierObservation[] }) {
  if (observations.length === 0) return null;
  return (
    <div className="mt-2 space-y-1.5">
      <SettingsText variant="xs" tone="muted" className="font-medium">
        operator 观察
      </SettingsText>
      {observations.map((obs) => (
        <div key={obs.id} className="rounded-md bg-[var(--console-bg)] px-3 py-2">
          <SettingsText as="p" variant="xs" tone="default">
            {obs.content}
          </SettingsText>
          <SettingsText as="p" variant="xs" tone="muted" className="mt-0.5">
            {obs.provenance.author} · {obs.provenance.date}
          </SettingsText>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Phase D: Evidence display (AC-D2)
// ---------------------------------------------------------------------------

function EvidenceSection({
  catId,
  searchKey,
  evidence,
  loading,
  onExpand,
}: {
  catId: string;
  searchKey: string;
  evidence: EvidenceSnippet[] | undefined;
  loading: boolean;
  onExpand: (catId: string, searchKey: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);

  const handleToggle = () => {
    if (!expanded && !evidence) {
      onExpand(catId, searchKey);
    }
    setExpanded(!expanded);
  };

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={handleToggle}
        className="flex items-center gap-1 text-xs text-cafe-secondary transition-colors hover:text-cafe"
      >
        <span
          className="inline-block transition-transform"
          style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}
        >
          ▾
        </span>
        最近证据
      </button>
      {expanded && (
        <div className="mt-2 space-y-1.5 pl-3">
          {loading && (
            <SettingsText as="p" variant="xs" tone="muted">
              加载中...
            </SettingsText>
          )}
          {evidence && evidence.length === 0 && !loading && (
            <SettingsText as="p" variant="xs" tone="muted" className="italic">
              暂无相关证据
            </SettingsText>
          )}
          {evidence?.map((ev, i) => (
            <div key={`${ev.anchor}-${i}`} className="rounded-md bg-[var(--console-bg)] px-3 py-2">
              <div className="flex items-center gap-2">
                <SettingsText variant="xs" tone="default" className="font-medium">
                  {ev.title}
                </SettingsText>
                <SettingsBadge
                  tone={ev.confidence === 'high' ? 'emerald' : ev.confidence === 'mid' ? 'amber' : 'slate'}
                  size="xxs"
                >
                  {ev.confidence}
                </SettingsBadge>
              </div>
              <SettingsText as="p" variant="xs" tone="muted" className="mt-0.5 line-clamp-2">
                {ev.snippet}
              </SettingsText>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cat profile card (Phase C + D integration)
// ---------------------------------------------------------------------------

function CatProfileCard({
  cat,
  observations,
  evidence,
  evidenceLoading,
  onSubmitObservation,
  onExpandEvidence,
}: {
  cat: DossierCatEntry;
  observations: DossierObservation[];
  evidence: EvidenceSnippet[] | undefined;
  evidenceLoading: boolean;
  onSubmitObservation: (catId: string, content: string) => Promise<DossierObservation | null>;
  onExpandEvidence: (catId: string, searchKey: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { dossier } = cat;
  // Evidence search key: nickname (most natural language hits) → displayName fallback
  const searchKey = cat.nickname || cat.displayName;

  return (
    <div className="border-t border-[var(--console-border-soft)] py-3 first:border-t-0">
      {/* Cat header */}
      <div className="flex items-center gap-2.5">
        <SettingsText variant="sm" tone="default" className="font-semibold">
          {cat.displayName}
        </SettingsText>
        {cat.nickname && (
          <SettingsText variant="xs" tone="muted">
            {cat.nickname}
          </SettingsText>
        )}
        <SettingsBadge tone={familyTone(cat.family)} size="xxs">
          {familyLabel(cat.family)}
        </SettingsBadge>
        {cat.runtime && (
          <SettingsBadge tone="slate" size="xxs">
            {cat.runtime}
          </SettingsBadge>
        )}
      </div>

      {/* Dossier content */}
      {dossier ? (
        <DossierDetail dossier={dossier} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
      ) : (
        <SettingsText as="p" variant="xs" tone="muted" className="mt-1.5 italic">
          暂无画像数据
        </SettingsText>
      )}

      {/* Phase D: operator observations (AC-D1) */}
      <ObservationList observations={observations} />
      <ObservationForm catId={cat.catId} onSubmit={onSubmitObservation} />

      {/* Phase D: Evidence display (AC-D2) */}
      <EvidenceSection
        catId={cat.catId}
        searchKey={searchKey}
        evidence={evidence}
        loading={evidenceLoading}
        onExpand={onExpandEvidence}
      />
    </div>
  );
}

function DossierDetail({
  dossier,
  expanded,
  onToggle,
}: {
  dossier: DossierProfileData;
  expanded: boolean;
  onToggle: () => void;
}) {
  const peaks = dossier.routingSignals?.peakCapabilities ?? [];
  const antis = dossier.routingSignals?.antiSignals ?? [];
  const hasSignals = peaks.length > 0 || antis.length > 0;

  return (
    <div className="mt-1.5 space-y-2">
      {/* One-liner */}
      {dossier.oneLiner && (
        <SettingsText as="p" variant="sm" tone="default">
          {dossier.oneLiner}
        </SettingsText>
      )}

      {/* L0 roster summary */}
      {dossier.l0RosterSummary && (
        <SettingsText as="p" variant="xs" tone="muted">
          L0 能力摘要：{dossier.l0RosterSummary}
        </SettingsText>
      )}

      {/* Expandable routing signals */}
      {hasSignals && (
        <div>
          <button
            type="button"
            onClick={onToggle}
            className="flex items-center gap-1 text-xs text-cafe-secondary transition-colors hover:text-cafe"
          >
            <span
              className="inline-block transition-transform"
              style={{ transform: expanded ? 'rotate(0deg)' : 'rotate(-90deg)' }}
            >
              ▾
            </span>
            路由信号
          </button>
          {expanded && (
            <div className="mt-2 space-y-2 pl-3">
              {peaks.length > 0 && (
                <div>
                  <SettingsText variant="xs" tone="muted" className="mb-1 font-medium">
                    擅长任务
                  </SettingsText>
                  <SignalTags signals={peaks} tone="emerald" />
                </div>
              )}
              {antis.length > 0 && (
                <div>
                  <SettingsText variant="xs" tone="muted" className="mb-1 font-medium">
                    不建议派给
                  </SettingsText>
                  <SignalTags signals={antis} tone="amber" />
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Provenance (Phase D adds operator observation button here) */}
      <div className="flex items-center gap-2">
        <ProvenanceBadge provenance={dossier.provenance} />
      </div>
    </div>
  );
}

function ModelGroupSection({
  group,
  observations,
  evidence,
  evidenceLoading,
  onSubmitObservation,
  onExpandEvidence,
}: {
  group: DossierModelGroup;
  observations: Record<string, DossierObservation[]>;
  evidence: Record<string, EvidenceSnippet[]>;
  evidenceLoading: Record<string, boolean>;
  onSubmitObservation: (catId: string, content: string) => Promise<DossierObservation | null>;
  onExpandEvidence: (catId: string, searchKey: string) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const catsWithDossier = group.cats.filter((c) => c.dossier !== null).length;

  return (
    <SettingsCollapsibleCard
      title={formatModelName(group.model)}
      count={group.cats.length}
      collapsed={collapsed}
      onToggle={() => setCollapsed(!collapsed)}
    >
      {/* Model coverage indicator */}
      {catsWithDossier < group.cats.length && (
        <SettingsText as="p" variant="xs" tone="muted" className="pb-2">
          {catsWithDossier}/{group.cats.length} 只猫有画像数据
        </SettingsText>
      )}
      {group.cats.map((cat) => (
        <CatProfileCard
          key={cat.catId}
          cat={cat}
          observations={observations[cat.catId] ?? []}
          evidence={evidence[cat.catId]}
          evidenceLoading={evidenceLoading[cat.catId] ?? false}
          onSubmitObservation={onSubmitObservation}
          onExpandEvidence={onExpandEvidence}
        />
      ))}
    </SettingsCollapsibleCard>
  );
}

function CoverageBar({
  coverage,
  totalCats,
  totalModels,
}: {
  coverage: number;
  totalCats: number;
  totalModels: number;
}) {
  const pct = Math.round(coverage * 100);
  return (
    <SettingsCard>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <SettingsText variant="sm" tone="default" className="font-semibold">
            画像覆盖率
          </SettingsText>
          <SettingsBadge tone={pct >= 80 ? 'emerald' : pct >= 50 ? 'amber' : 'slate'} size="xxs">
            {pct}%
          </SettingsBadge>
        </div>
        <SettingsText variant="xs" tone="muted">
          {totalCats} 只猫 · {totalModels} 个模型
        </SettingsText>
      </div>
      {/* Progress bar */}
      <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-[var(--console-border-soft)]">
        <div className="h-full rounded-full bg-[var(--cafe-accent)] transition-all" style={{ width: `${pct}%` }} />
      </div>
    </SettingsCard>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function CatDossierContent() {
  const { data, loading, error } = useDossierProfiles();
  const { observations, submitObservation } = useDossierObservations();
  const { evidence, loading: evidenceLoading, fetchEvidence } = useDossierEvidence();

  return (
    <div className="space-y-5">
      <SettingsPageHeader title="猫猫画像" subtitle="按模型分组的能力画像、路由信号与来源追溯" />

      {loading && (
        <SettingsText as="p" variant="sm" tone="muted">
          加载中...
        </SettingsText>
      )}

      {error && (
        <SettingsText as="p" variant="sm" tone="red">
          {error}
        </SettingsText>
      )}

      {!loading && !error && (!data || data.modelGroups.length === 0) && (
        <SettingsEmptyState title="暂无画像数据" description="请先在 cat-dossier.md 中添加结构化画像块。" />
      )}

      {data && data.modelGroups.length > 0 && (
        <div className="space-y-4">
          {/* Coverage overview */}
          <SettingsSection title="按模型分组" description="画像描述的是模型认知能力，每只猫是模型的一个实例化引用。">
            <CoverageBar
              coverage={data.meta.dossierCoverage}
              totalCats={data.meta.totalCats}
              totalModels={data.meta.totalModels}
            />
          </SettingsSection>

          {/* Model groups */}
          {data.modelGroups.map((group) => (
            <ModelGroupSection
              key={group.model}
              group={group}
              observations={observations}
              evidence={evidence}
              evidenceLoading={evidenceLoading}
              onSubmitObservation={submitObservation}
              onExpandEvidence={fetchEvidence}
            />
          ))}
        </div>
      )}
    </div>
  );
}
