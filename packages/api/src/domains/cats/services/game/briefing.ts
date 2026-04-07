import type { GameEvent, GameRuntime, SeatId } from '@cat-cafe/shared';
import { catRegistry } from '@cat-cafe/shared';

const ROLE_DISPLAY: Record<string, string> = {
  wolf: '狼人',
  seer: '预言家',
  witch: '女巫',
  hunter: '猎人',
  guard: '守卫',
  idiot: '白痴',
  villager: '村民',
};

const PHASE_ACTION_MAP: Record<string, { action: string; verb: string; targetRequired: boolean }> = {
  night_wolf: { action: 'kill', verb: '选择要杀害的目标', targetRequired: true },
  night_seer: { action: 'divine', verb: '选择要查验的目标', targetRequired: true },
  night_witch: { action: 'witch_action', verb: '选择使用解药/毒药或跳过', targetRequired: false },
  night_guard: { action: 'guard', verb: '选择要守护的目标（不能连续两晚保护同一人）', targetRequired: true },
  day_discuss: { action: 'speak', verb: '发表你的发言', targetRequired: false },
  day_vote: { action: 'vote', verb: '投票选择要放逐的玩家', targetRequired: true },
  day_last_words: { action: 'last_words', verb: '发表遗言', targetRequired: false },
};

function displayName(actorId: string): string {
  const entry = catRegistry.tryGet(actorId);
  if (!entry) return actorId;
  const breed = entry.config.breedDisplayName ?? entry.config.displayName;
  return breed ? `${breed}(${actorId})` : actorId;
}

function roleCN(role: string): string {
  return ROLE_DISPLAY[role] ?? role;
}

function seatLabel(seat: { seatId: SeatId; actorId: string }): string {
  const num = seat.seatId.slice(1);
  return `座位${num}(${displayName(seat.actorId)})`;
}

function aliveSummary(runtime: GameRuntime, selfSeatId: SeatId): string {
  return runtime.seats
    .filter((s) => s.alive)
    .map((s) => (s.seatId === selfSeatId ? `座位${s.seatId.slice(1)}(你)` : seatLabel(s)))
    .join(', ');
}

function deadSummary(runtime: GameRuntime): string {
  const dead = runtime.seats.filter((s) => !s.alive);
  if (dead.length === 0) return '';

  const parts = dead.map((s) => {
    const deathEvent = runtime.eventLog.find(
      (e) =>
        e.type === 'dawn_announce' && e.payload['deadSeats'] && (e.payload['deadSeats'] as string[]).includes(s.seatId),
    );
    const when = deathEvent ? `第${deathEvent.round}轮` : '已淘汰';
    return `${seatLabel(s)}(${when})`;
  });
  return parts.join(', ');
}

function gameComposition(runtime: GameRuntime): string {
  const total = runtime.seats.length;
  const roleCounts: Record<string, number> = {};
  for (const seat of runtime.seats) {
    const name = roleCN(seat.role);
    roleCounts[name] = (roleCounts[name] ?? 0) + 1;
  }
  const parts = Object.entries(roleCounts).map(([name, count]) => `${name}x${count}`);
  return `${total}人局 — 板子：${parts.join(' / ')}`;
}

/** Extract wolf kill target from this round's eventLog (for witch briefing) */
function wolfKillTarget(runtime: GameRuntime): string | null {
  for (const evt of runtime.eventLog) {
    if (evt.round !== runtime.round) continue;
    if (evt.type === 'action.submitted' && evt.payload['actionName'] === 'kill') {
      return evt.payload['target'] as string;
    }
    if (evt.type === 'action.fallback' && evt.payload['actionName'] === 'kill') {
      return evt.payload['target'] as string;
    }
  }
  return null;
}

/** Check which potions the witch has already used (by scanning eventLog) */
function witchPotionState(runtime: GameRuntime, witchSeatId: SeatId): { healUsed: boolean; poisonUsed: boolean } {
  let healUsed = false;
  let poisonUsed = false;
  for (const evt of runtime.eventLog) {
    if (evt.type !== 'action.submitted') continue;
    if (evt.payload['seatId'] !== witchSeatId) continue;
    if (evt.payload['actionName'] === 'heal') healUsed = true;
    if (evt.payload['actionName'] === 'poison') poisonUsed = true;
  }
  return { healUsed, poisonUsed };
}

/** Witch-specific tool block: shows kill target, potion state, and heal/poison/skip options */
function witchToolBlock(runtime: GameRuntime, seatId: SeatId): string {
  const num = seatId.slice(1);
  const potions = witchPotionState(runtime, seatId);
  const killTarget = wolfKillTarget(runtime);
  const lines: string[] = [];

  if (killTarget) {
    const targetSeat = runtime.seats.find((s) => s.seatId === killTarget);
    lines.push(`🔪 今晚被狼人杀害的是：${targetSeat ? seatLabel(targetSeat) : killTarget}`);
  } else {
    lines.push('🔪 今晚平安夜（无人被杀）。');
  }
  lines.push(
    `💊 药水：解药${potions.healUsed ? '❌已用' : '✅可用'} / 毒药${potions.poisonUsed ? '❌已用' : '✅可用'}`,
  );
  lines.push('');
  lines.push('使用 cat_cafe_submit_game_action 提交行动：');
  lines.push(`  gameId: "${runtime.gameId}", round: ${runtime.round}, phase: "night_witch", seat: ${num}`);
  if (!potions.healUsed && killTarget) {
    const killNum = killTarget.slice(1);
    lines.push(`  ▸ 救人：action: "heal", target: ${killNum}, text: "<理由>", nonce: "<随机串>"`);
  }
  if (!potions.poisonUsed) {
    lines.push('  ▸ 毒人：action: "poison", target: <座位号>, text: "<理由>", nonce: "<随机串>"');
  }
  lines.push('  ▸ 跳过：不提交行动，等待超时自动跳过');
  if (!potions.healUsed || !potions.poisonUsed) {
    lines.push('⚠️ 一晚只能用一瓶药。');
  }
  return lines.join('\n');
}

function toolUsageBlock(runtime: GameRuntime, seatId: SeatId, phase: string): string {
  if (phase === 'night_witch') return witchToolBlock(runtime, seatId);
  const mapping = PHASE_ACTION_MAP[phase];
  if (!mapping) return '';

  const num = seatId.slice(1);
  const lines = [
    '使用 cat_cafe_submit_game_action 工具提交行动：',
    `  gameId: "${runtime.gameId}"`,
    `  round: ${runtime.round}`,
    `  phase: "${phase}"`,
    `  seat: ${num}`,
    `  action: "${mapping.action}"`,
  ];
  if (mapping.targetRequired) {
    lines.push('  target: <目标座位号>');
  }
  if (phase === 'day_discuss' || phase === 'day_last_words') {
    lines.push('  text: "<你的发言内容>"');
  } else if (phase.startsWith('night_')) {
    lines.push('  text: "<简要说明你的理由（1句话）>"');
  }
  lines.push('  nonce: "<随机字符串>"');
  return lines.join('\n');
}

export function buildFirstWakeBriefing(params: {
  gameRuntime: GameRuntime;
  seatId: SeatId;
  teammates?: Array<{ catId: string; seatId: SeatId }>;
}): string {
  const { gameRuntime: rt, seatId, teammates } = params;
  const seat = rt.seats.find((s) => s.seatId === seatId);
  if (!seat) return `[错误] 找不到座位 ${seatId}`;
  const roleDef = rt.definition.roles.find((r) => r.name === seat.role);

  const sections: string[] = [];

  sections.push(
    `🌙 你好，${displayName(seat.actorId)}！你被分配到了 **座位 ${seatId.slice(1)}**。`,
    `你的身份是 **${roleCN(seat.role)}** — ${roleDef?.description ?? '未知角色'}`,
  );

  sections.push(`🎮 ${gameComposition(rt)}`);

  if (teammates && teammates.length > 0) {
    const mateStr = teammates.map((t) => `座位${t.seatId.slice(1)}(${displayName(t.catId)})`).join(', ');
    sections.push(`🐺 你的狼队友：${mateStr}`);
  }

  sections.push('');
  sections.push(`📋 当前存活玩家：${aliveSummary(rt, seatId)}`);

  const dead = deadSummary(rt);
  if (dead) sections.push(`💀 已死亡：${dead}`);

  const mapping = PHASE_ACTION_MAP[rt.currentPhase];
  if (mapping) {
    sections.push('');
    sections.push(`🎯 现在是 **第 ${rt.round} 轮，${rt.currentPhase} 阶段**。请${mapping.verb}。`);
    sections.push('');
    sections.push(toolUsageBlock(rt, seatId, rt.currentPhase));
  }

  sections.push('');
  sections.push('⚠️ 你有 60 秒时间做出决定。超时将跳过行动（夜间角色不会被系统代行）。');

  return sections.join('\n');
}

export function buildResumeCapsule(params: {
  gameRuntime: GameRuntime;
  seatId: SeatId;
  recentEvents?: GameEvent[];
}): string {
  const { gameRuntime: rt, seatId } = params;
  const seat = rt.seats.find((s) => s.seatId === seatId);
  if (!seat) return `[错误] 找不到座位 ${seatId}`;

  const sections: string[] = [];

  sections.push(
    `🔄 你是 座位${seatId.slice(1)} ${roleCN(seat.role)}。当前第 ${rt.round} 轮，${rt.currentPhase} 阶段。`,
  );
  sections.push(`🎮 ${gameComposition(rt)}`);
  sections.push(`存活：${aliveSummary(rt, seatId)}`);

  const dead = deadSummary(rt);
  if (dead) sections.push(`已死亡：${dead}`);

  const mapping = PHASE_ACTION_MAP[rt.currentPhase];
  if (mapping) {
    sections.push('');
    sections.push(`🎯 请${mapping.verb}。`);
    sections.push(toolUsageBlock(rt, seatId, rt.currentPhase));
  }

  sections.push('');
  sections.push('💡 你可以用 get_thread_context 回看之前的讨论记录和投票结果。');

  return sections.join('\n');
}

export function buildRebriefing(params: {
  gameRuntime: GameRuntime;
  seatId: SeatId;
  teammates?: Array<{ catId: string; seatId: SeatId }>;
  recentEvents?: GameEvent[];
  previousKnowledge?: string[];
}): string {
  const { gameRuntime: rt, seatId, teammates, previousKnowledge } = params;
  const seat = rt.seats.find((s) => s.seatId === seatId);
  if (!seat) return `[错误] 找不到座位 ${seatId}`;
  const roleDef = rt.definition.roles.find((r) => r.name === seat.role);

  const sections: string[] = [];

  sections.push(
    `🔁 Session 恢复 — 完整身份重述`,
    '',
    `你是 **${displayName(seat.actorId)}**，座位 ${seatId.slice(1)}，身份 **${roleCN(seat.role)}** — ${roleDef?.description ?? '未知角色'}`,
  );

  if (teammates && teammates.length > 0) {
    const mateStr = teammates.map((t) => `座位${t.seatId.slice(1)}(${displayName(t.catId)})`).join(', ');
    sections.push(`🐺 你的狼队友：${mateStr}`);
  }

  sections.push('');
  sections.push(`🎮 ${gameComposition(rt)}`);
  sections.push(`📋 当前第 ${rt.round} 轮，${rt.currentPhase} 阶段`);
  sections.push(`存活：${aliveSummary(rt, seatId)}`);

  const dead = deadSummary(rt);
  if (dead) sections.push(`已死亡：${dead}`);

  if (previousKnowledge && previousKnowledge.length > 0) {
    sections.push('');
    sections.push('📖 你之前获得的信息：');
    for (const k of previousKnowledge) {
      sections.push(`  - ${k}`);
    }
  }

  const mapping = PHASE_ACTION_MAP[rt.currentPhase];
  if (mapping) {
    sections.push('');
    sections.push(`🎯 请${mapping.verb}。`);
    sections.push('');
    sections.push(toolUsageBlock(rt, seatId, rt.currentPhase));
  }

  sections.push('');
  sections.push('💡 你可以用 get_thread_context 回看之前的讨论记录和投票结果。');

  return sections.join('\n');
}
