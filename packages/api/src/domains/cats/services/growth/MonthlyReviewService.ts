/**
 * F160 AC-E3: Monthly Cat Self-Review Generator
 * Deterministically builds a Markdown review from journey data.
 * Called by the `monthlyReview` scheduler template on cron trigger.
 */

import type { CatBond, CatJourneyProfile, EvolutionEvent, FootfallEvent, TraitDimension } from '@cat-cafe/shared';
import { catRegistry, GROWTH_DIMENSIONS } from '@cat-cafe/shared';
import type { EvolutionService } from './EvolutionService.js';
import type { GrowthService } from './GrowthService.js';

const DIM_LABELS: Record<TraitDimension, string> = {
  architecture: '架构力',
  review: '审查力',
  aesthetics: '审美力',
  execution: '执行力',
  collaboration: '协作力',
  insight: '洞察力',
};

const SOURCE_LABELS: Record<string, string> = {
  task_complete: '完成任务',
  session_seal: '会话封存',
  review_given: '代码审查',
  review_received: '收到审查',
  tool_use: '工具调用',
  tool_use_mcp: 'MCP 工具',
  tool_use_skill: '技能调用',
  mention_collab: '@协作',
  deep_collab: '深度协作',
  discussion: '讨论',
  pr_merged: 'PR 合并',
  bug_caught: '发现 Bug',
  design_feedback: '设计反馈',
  rich_block_create: '创建卡片',
  evidence_cite: '引用证据',
  cache_efficiency: '缓存效率',
  ideate_discussion: '构思讨论',
  error_recovery: '错误恢复',
  fast_execution: '快速执行',
};

const BOND_LEVELS: Record<string, string> = { soulmate: '灵魂伙伴', partner: '伙伴', acquaintance: '相识' };

/** Default review period: 30 days. */
const DEFAULT_PERIOD_MS = 30 * 86_400_000;

export class MonthlyReviewService {
  constructor(
    private readonly growth: GrowthService,
    private readonly evolution: EvolutionService,
  ) {}

  /** Generate a Markdown review for one cat. Returns null if cat not found. */
  async generate(catId: string, periodMs = DEFAULT_PERIOD_MS): Promise<string | null> {
    const profile = await this.growth.getProfile(catId);
    if (!profile) return null;

    const since = Date.now() - periodMs;
    const [allEvents, allMilestones, bonds] = await Promise.all([
      this.growth.getXpEvents(catId, 200, 0),
      this.evolution.getEvents(catId, 50, 0),
      this.growth.getBonds(catId),
    ]);

    return buildMarkdown(
      profile,
      allEvents.filter((e) => e.timestamp >= since),
      allMilestones.filter((e) => e.timestamp >= since),
      bonds,
    );
  }
}

// ── Markdown builder ─────────────────────────────────────────────

function buildMarkdown(
  profile: CatJourneyProfile,
  events: FootfallEvent[],
  milestones: EvolutionEvent[],
  bonds: (CatBond & { level: string })[],
): string {
  const { attributes } = profile;
  const name = profile.nickname ?? profile.displayName;
  const month = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  const lines: string[] = [];

  // Header
  lines.push(`# ${name} 月度足迹回顾`, '');
  lines.push(`> ${month} · Lv.${attributes.overallLevel} · ${attributes.totalXp.toLocaleString()} 足迹点`);
  if (profile.currentTitle) lines.push(`> 当前称号: 「${profile.currentTitle.label.zh}」`);
  lines.push('');

  // Dimension stats
  lines.push('## 维度成长', '', '| 维度 | 等级 | 足迹点 |', '|------|------|--------|');
  for (const dim of GROWTH_DIMENSIONS) {
    const s = attributes.stats[dim];
    if (s) lines.push(`| ${DIM_LABELS[dim]} | Lv.${s.level} | ${s.xp.toLocaleString()} |`);
  }
  lines.push('');

  // Milestones
  if (milestones.length > 0) {
    lines.push('## 本月里程碑', '');
    for (const m of milestones) lines.push(`- ${m.narrative.zh}`);
    lines.push('');
  }

  // Activity summary (aggregate by source, sort by total XP desc)
  if (events.length > 0) {
    const bySource = new Map<string, { count: number; xp: number }>();
    for (const ev of events) {
      const cur = bySource.get(ev.source) ?? { count: 0, xp: 0 };
      cur.count++;
      cur.xp += ev.xp;
      bySource.set(ev.source, cur);
    }
    lines.push('## 活动概要', '');
    for (const [source, { count, xp }] of [...bySource].sort((a, b) => b[1].xp - a[1].xp)) {
      lines.push(`- ${SOURCE_LABELS[source] ?? source} ${count} 次 (+${xp.toLocaleString()} 足迹点)`);
    }
    lines.push('');
  }

  // Bonds (top 5)
  const active = bonds.filter((b) => b.score > 0).slice(0, 5);
  if (active.length > 0) {
    lines.push('## 协作关系', '');
    for (const bond of active) {
      const otherId = bond.catA === profile.catId ? bond.catB : bond.catA;
      const other = catRegistry.tryGet(otherId);
      const otherName = other?.config.nickname ?? other?.config.displayName ?? otherId;
      lines.push(`- 与 ${otherName}: ${BOND_LEVELS[bond.level] ?? bond.level} (${bond.score} 分)`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
