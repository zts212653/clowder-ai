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

function toolUsageBlock(runtime: GameRuntime, seatId: SeatId, phase: string): string {
  const mapping = PHASE_ACTION_MAP[phase];
  if (!mapping) return '';

  const num = seatId.slice(1);
  const lines = [
    '使用 submit_game_action 工具提交行动：',
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
  sections.push('⚠️ 你有 45 秒时间做出决定。超时将自动执行默认行动。');

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
