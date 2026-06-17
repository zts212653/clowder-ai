/**
 * F233 Phase A — renderBriefingCard（DutyBriefing → rich card payload）
 *
 * KD-3 异常优先：healthy 仅一行计数，不列条目。
 * KD-6 卡面交互诚实：card 无 actions（零按钮）——唯一交互 = 条目锚点跳转。
 * AC-A4 默认态正文 ≤15 行：超限按「晾龄升序先砍」（保留晾龄长=更紧急的）+ 折叠「另有 N 条」。
 * 锚点：markdown 链接 `/thread/{threadId}`；void-pass 无锚点（telemetry HMAC 不可逆）显式标注。
 */

import type { BallEntry, DutyBriefing, RichCardBlock } from '@cat-cafe/shared';
import { DUTY_BRIEFING_CARD_ID, MAX_BRIEFING_BODY_LINES } from './constants.js';

const CARD_ID = DUTY_BRIEFING_CARD_ID;

/** 区 emoji（每条目前缀，省掉单独区标题行——更紧凑） */
const SECTION_EMOJI: Record<string, string> = {
  needsUser: '🔴',
  deadBalls: '💀',
  voidPasses: '⚠️',
  staleBlocked: '💤',
};

function formatAge(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.floor(hr / 24)}天`;
}

function entryLine(emoji: string, e: BallEntry): string {
  const url = e.anchor.threadId ? `/thread/${e.anchor.threadId}` : null;
  const title = url ? `[${e.title}](${url})` : e.title;
  const tags: string[] = [];
  if (e.holder) tags.push(`@${e.holder}`);
  tags.push(`晾${formatAge(e.ageMs)}`);
  if (e.confidence === 'heuristic') tags.push('推断');
  if (!url) tags.push('无跳转'); // void-pass：telemetry HMAC 不可逆，诚实标注
  return `${emoji} ${title} · ${tags.join(' · ')}`;
}

interface TaggedEntry {
  emoji: string;
  entry: BallEntry;
}

interface EntrySection {
  key: 'needsUser' | 'deadBalls' | 'voidPasses' | 'staleBlocked';
  items: TaggedEntry[];
}

/** 按区顺序（needsUser→dead→void→stale）展平，区内已是晾龄降序 */
function flattenEntries(briefing: DutyBriefing): TaggedEntry[] {
  return [
    ...briefing.needsUser.map((entry) => ({ emoji: SECTION_EMOJI.needsUser, entry })),
    ...briefing.deadBalls.map((entry) => ({ emoji: SECTION_EMOJI.deadBalls, entry })),
    ...briefing.voidPasses.map((entry) => ({ emoji: SECTION_EMOJI.voidPasses, entry })),
    ...briefing.staleBlocked.map((entry) => ({ emoji: SECTION_EMOJI.staleBlocked, entry })),
  ];
}

function sectionsInPriorityOrder(briefing: DutyBriefing): EntrySection[] {
  return [
    { key: 'needsUser', items: briefing.needsUser.map((entry) => ({ emoji: SECTION_EMOJI.needsUser, entry })) },
    { key: 'deadBalls', items: briefing.deadBalls.map((entry) => ({ emoji: SECTION_EMOJI.deadBalls, entry })) },
    { key: 'voidPasses', items: briefing.voidPasses.map((entry) => ({ emoji: SECTION_EMOJI.voidPasses, entry })) },
    {
      key: 'staleBlocked',
      items: briefing.staleBlocked.map((entry) => ({ emoji: SECTION_EMOJI.staleBlocked, entry })),
    },
  ];
}

function reserveOnePerSection(sections: EntrySection[], selected: Set<BallEntry>, remaining: number): number {
  let slots = remaining;
  for (const section of sections) {
    if (slots <= 0) break;
    const first = section.items[0]?.entry;
    if (!first) continue;
    selected.add(first);
    slots -= 1;
  }
  return slots;
}

function fillRemainingByPriority(sections: EntrySection[], selected: Set<BallEntry>, remaining: number): void {
  let slots = remaining;
  for (const section of sections) {
    if (slots <= 0) break;
    for (const tagged of section.items) {
      if (slots <= 0) break;
      if (selected.has(tagged.entry)) continue;
      selected.add(tagged.entry);
      slots -= 1;
    }
  }
}

function selectEntriesWithinBudget(
  briefing: DutyBriefing,
  keep: number,
): { visible: TaggedEntry[]; truncated: number } {
  const all = flattenEntries(briefing);
  if (all.length <= keep) return { visible: all, truncated: 0 };

  const sections = sectionsInPriorityOrder(briefing);
  const selected = new Set<BallEntry>();
  const remaining = reserveOnePerSection(sections, selected, keep);
  fillRemainingByPriority(sections, selected, remaining);

  const visible = all.filter((tagged) => selected.has(tagged.entry));
  return { visible, truncated: all.length - visible.length };
}

export function renderBriefingCard(briefing: DutyBriefing): RichCardBlock {
  const { counts, healthy } = briefing;

  const countLine = `🔴 ${counts.needsUser} 需要你 · 💀 ${counts.dead} 死球 · ⚠️ ${counts.voidPass} 虚空 · 💤 ${counts.staleBlocked} 睡美人 · 🟢 ${counts.active} 正常`;
  const healthyLine = `🟢 其余 ${healthy.count} 颗正常推进 · 最老心跳 ${formatAge(healthy.oldestHeartbeatMs)}`;
  const degradedLine = briefing.bindingStatus === 'degraded' ? '⚠️ 简报 thread 绑定失效，已降级投递' : null;
  const degradedSourcesLine =
    briefing.degradedSources.length > 0 ? `⚠️ 数据降级：${briefing.degradedSources.join(' / ')}` : null;

  // ≤15 行预算（AC-A4）：扣固定行（计数 + healthy + 可选 degraded），余下给异常条目
  const fixedLines = 1 + 1 + (degradedLine ? 1 : 0) + (degradedSourcesLine ? 1 : 0);
  const entryBudget = MAX_BRIEFING_BODY_LINES - fixedLines;

  let visible = flattenEntries(briefing);
  let truncated = 0;
  if (visible.length > entryBudget) {
    // 留一行给折叠提示；优先保区，再在区内按既有晾龄降序保留更紧急条目。
    const keep = Math.max(0, entryBudget - 1);
    ({ visible, truncated } = selectEntriesWithinBudget(briefing, keep));
  }

  const lines: string[] = [countLine];
  if (degradedLine) lines.push(degradedLine);
  if (degradedSourcesLine) lines.push(degradedSourcesLine);
  for (const t of visible) lines.push(entryLine(t.emoji, t.entry));
  if (truncated > 0) lines.push(`… 另有 ${truncated} 条（晾龄较短，已折叠）`);
  lines.push(healthyLine);

  const hasAlarm = counts.needsUser + counts.dead + counts.voidPass + counts.staleBlocked > 0;

  return {
    id: CARD_ID,
    kind: 'card',
    v: 1,
    title: '☀️ 值班简报',
    tone: hasAlarm ? 'warning' : 'info',
    bodyMarkdown: lines.join('\n'),
    // KD-6: 无 actions（零按钮）——唯一交互是 bodyMarkdown 里的锚点链接
  };
}
