'use client';

import type { GameResultStats } from '@cat-cafe/shared';

interface GameResultScreenProps {
  stats: GameResultStats;
  onClose: () => void;
}

const ROLE_ICONS: Record<string, string> = {
  seer: '🔮',
  witch: '🧪',
  guard: '🛡️',
  wolf: '🐺',
  hunter: '🔫',
  villager: '👤',
  idiot: '🤡',
};

const FACTION_COLORS: Record<string, string> = {
  wolf: 'var(--ww-faction-wolf)',
  village: 'var(--ww-faction-village)',
  third: 'var(--ww-accent-info)',
};

export function formatDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${String(sec).padStart(2, '0')}`;
}

export function GameResultScreen({ stats, onClose }: GameResultScreenProps) {
  const isWolfWin = stats.winner === 'wolf';
  const mvp = stats.players.find((p) => p.seatId === stats.mvpSeatId);

  return (
    <div data-testid="game-result-screen" className="flex flex-col items-center gap-6 p-6 overflow-y-auto flex-1">
      {/* Winner Banner */}
      <div data-testid="winner-banner" className="flex flex-col items-center gap-2 py-6">
        <span className="text-4xl">{isWolfWin ? '🐺' : '🏘️'}</span>
        <h2
          className="text-2xl font-bold"
          style={{ color: isWolfWin ? 'var(--ww-faction-wolf)' : 'var(--ww-faction-village)' }}
        >
          {isWolfWin ? '狼人阵营胜利' : '好人阵营胜利'}
        </h2>
        <span className="text-sm text-ww-muted">
          {stats.rounds} 轮 · {formatDuration(stats.duration)}
        </span>
      </div>

      {/* MVP Card */}
      {mvp && (
        <div
          data-testid="mvp-card"
          className="flex items-center gap-3 bg-ww-card rounded-lg px-5 py-3 border border-ww-info-soft"
        >
          <span className="text-2xl">🏆</span>
          <div className="flex flex-col">
            <span className="text-xs text-ww-info font-bold tracking-wider">MVP</span>
            <span className="text-sm font-semibold text-ww-main">
              {mvp.actorId} ({mvp.seatId})
            </span>
            <span className="text-xs text-ww-muted">{stats.mvpReason}</span>
          </div>
        </div>
      )}

      {/* Player Stats Table */}
      <div data-testid="player-stats" className="w-full max-w-lg">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[10px] text-ww-dim font-mono tracking-wider border-b border-ww-subtle">
              <th className="text-left py-2 px-1">座位</th>
              <th className="text-left py-2 px-1">玩家</th>
              <th className="text-left py-2 px-1">角色</th>
              <th className="text-center py-2 px-1">击杀</th>
              <th className="text-center py-2 px-1">救助</th>
              <th className="text-center py-2 px-1">查验</th>
              <th className="text-center py-2 px-1">存活</th>
              <th className="text-center py-2 px-1">胜负</th>
            </tr>
          </thead>
          <tbody>
            {stats.players.map((p) => {
              const factionColor = FACTION_COLORS[p.faction] ?? 'var(--ww-text-muted)';
              return (
                <tr
                  key={p.seatId}
                  data-testid={`stat-${p.seatId}`}
                  className={`border-b border-ww-subtle-soft${!p.survived ? ' opacity-50' : ''}`}
                >
                  <td className="py-1.5 px-1 font-mono text-xs" style={{ color: factionColor }}>
                    {p.seatId}
                  </td>
                  <td className="py-1.5 px-1 text-ww-main">{p.actorId}</td>
                  <td className="py-1.5 px-1" style={{ color: factionColor }}>
                    {ROLE_ICONS[p.role] ?? '🎭'} {p.role}
                  </td>
                  <td className="py-1.5 px-1 text-center font-mono">{p.killCount || '-'}</td>
                  <td className="py-1.5 px-1 text-center font-mono">{p.savedCount || '-'}</td>
                  <td className="py-1.5 px-1 text-center font-mono">{p.divineCount || '-'}</td>
                  <td className="py-1.5 px-1 text-center">{p.survived ? '✓' : '💀'}</td>
                  <td className="py-1.5 px-1 text-center">{p.won ? '🏆' : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Close Button */}
      <button
        type="button"
        data-testid="result-close-btn"
        onClick={onClose}
        className="mt-4 px-8 py-2.5 rounded-lg bg-ww-danger text-ww-main font-bold text-sm hover:brightness-110 transition-colors"
      >
        返回聊天
      </button>
    </div>
  );
}
