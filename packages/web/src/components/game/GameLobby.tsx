'use client';

import { useCallback, useMemo, useState } from 'react';
import type { CatData } from '@/hooks/useCatData';

/** Available board presets — mirrors WEREWOLF_PRESETS on backend */
const BOARD_PRESETS = [
  { count: 6, label: '6人局', desc: '2狼 1预言 1女巫 2村民' },
  { count: 7, label: '7人局', desc: '2狼 1预言 1女巫 1猎人 2村民' },
  { count: 8, label: '8人局', desc: '3狼 1预言 1女巫 1猎人 2村民' },
  { count: 9, label: '9人局', desc: '3狼 1预言 1女巫 1猎人 3村民' },
  { count: 10, label: '10人局', desc: '3狼 1预言 1女巫 1猎人 4村民' },
  { count: 12, label: '12人局', desc: '4狼 1预言 1女巫 1猎人 1守卫 4村民' },
] as const;

export interface GameStartPayload {
  gameType: 'werewolf';
  humanRole: 'player' | 'god-view' | 'detective';
  playerCount: number;
  catIds: string[];
  voiceMode: boolean;
  detectiveCatId?: string;
}

interface GameLobbyProps {
  mode: 'player' | 'god-view' | 'detective';
  cats: CatData[];
  onConfirm: (payload: GameStartPayload) => void;
  onCancel: () => void;
}

export function GameLobby({ mode, cats, onConfirm, onCancel }: GameLobbyProps) {
  const [selectedPreset, setSelectedPreset] = useState(7);
  const [selectedCats, setSelectedCats] = useState<Set<string>>(() => new Set<string>());
  const [voiceMode, setVoiceMode] = useState(false);
  // Detective mode: which cat to bind to
  const [detectiveCatId, setDetectiveCatId] = useState<string | null>(null);

  // How many cat seats needed (detective = same as god-view: all cats)
  const catSeatsNeeded = mode === 'player' ? selectedPreset - 1 : selectedPreset;
  const selectedCatList = useMemo(() => cats.filter((c) => selectedCats.has(c.id)), [cats, selectedCats]);
  // Must select enough cats to fill all seats (no duplicate actors!)
  const canStart =
    selectedCatList.length >= catSeatsNeeded &&
    (mode !== 'detective' || (detectiveCatId !== null && selectedCats.has(detectiveCatId)));

  const toggleCat = useCallback((catId: string) => {
    setSelectedCats((prev) => {
      const next = new Set(prev);
      if (next.has(catId)) {
        next.delete(catId);
        // Clear detective binding if the bound cat was deselected
        setDetectiveCatId((prev) => (prev === catId ? null : prev));
      } else {
        next.add(catId);
      }
      return next;
    });
  }, []);

  const handleConfirm = useCallback(() => {
    onConfirm({
      gameType: 'werewolf',
      humanRole: mode,
      playerCount: selectedPreset,
      catIds: selectedCatList.map((c) => c.id),
      voiceMode,
      ...(mode === 'detective' && detectiveCatId ? { detectiveCatId } : {}),
    });
  }, [mode, selectedPreset, selectedCatList, voiceMode, detectiveCatId, onConfirm]);

  return (
    <div
      data-testid="game-lobby"
      data-theme="werewolf-cute"
      className="fixed inset-0 z-50 flex items-center justify-center bg-ww-base-overlay backdrop-blur-sm"
    >
      <div className="bg-ww-topbar rounded-2xl border border-ww-subtle w-full max-w-lg mx-4 overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-ww-subtle">
          <h2 className="text-ww-main font-semibold text-lg">
            狼人杀 — {mode === 'player' ? '玩家模式' : mode === 'detective' ? '推理模式' : '上帝视角'}
          </h2>
          <button
            onClick={onCancel}
            className="text-ww-dim hover:text-ww-main transition-colors p-1 rounded"
            aria-label="取消"
          >
            <svg className="w-5 h-5" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                clipRule="evenodd"
              />
            </svg>
          </button>
        </div>

        {/* Board preset selection */}
        <div className="px-6 py-4">
          <div className="text-sm text-ww-muted font-medium mb-3">选择板子</div>
          <div className="grid grid-cols-3 gap-2">
            {BOARD_PRESETS.map((preset) => (
              <button
                key={preset.count}
                data-testid={`preset-${preset.count}`}
                onClick={() => setSelectedPreset(preset.count)}
                className={`rounded-lg px-3 py-2 text-left transition-colors border ${
                  selectedPreset === preset.count
                    ? 'border-ww-cute bg-ww-cute-soft text-ww-cute'
                    : 'border-ww-subtle text-ww-muted hover:border-ww-active'
                }`}
              >
                <div className="text-sm font-semibold">{preset.label}</div>
                <div className="text-[10px] opacity-70 mt-0.5">{preset.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Cat selection */}
        <div className="px-6 py-4 border-t border-ww-subtle">
          <div className="text-sm text-ww-muted font-medium mb-3">
            选择参赛猫猫（点击添加）
            <span className="ml-2 text-xs">
              ({selectedCatList.length}/{catSeatsNeeded} 席位
              {selectedCatList.length < catSeatsNeeded && (
                <span className="text-ww-danger ml-1">还需 {catSeatsNeeded - selectedCatList.length} 只</span>
              )}
              )
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {cats.map((cat) => (
              <button
                key={cat.id}
                data-testid={`cat-toggle-${cat.id}`}
                onClick={() => toggleCat(cat.id)}
                className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-sm transition-colors border ${
                  selectedCats.has(cat.id)
                    ? 'border-current bg-white/5 font-medium'
                    : 'border-ww-subtle text-ww-dim hover:border-ww-active'
                }`}
                style={selectedCats.has(cat.id) ? { color: cat.color.primary } : undefined}
              >
                <img
                  src={cat.avatar}
                  alt={cat.displayName}
                  className="w-5 h-5 rounded-full"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = 'none';
                  }}
                />
                {cat.displayName}
              </button>
            ))}
          </div>
        </div>

        {/* Detective mode: pick ONE cat to bind */}
        {mode === 'detective' && (
          <div className="px-6 py-4 border-t border-ww-subtle">
            <div className="text-sm text-ww-muted font-medium mb-3">
              选择绑定猫猫
              <span className="ml-2 text-xs opacity-70">（只能看到这只猫的视角）</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {selectedCatList.map((cat) => (
                <button
                  key={cat.id}
                  data-testid={`detective-bind-${cat.id}`}
                  onClick={() => setDetectiveCatId(cat.id)}
                  className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-sm transition-colors border ${
                    detectiveCatId === cat.id
                      ? 'border-ww-cute bg-ww-cute-soft text-ww-cute font-medium'
                      : 'border-ww-subtle text-ww-dim hover:border-ww-active'
                  }`}
                >
                  <img
                    src={cat.avatar}
                    alt={cat.displayName}
                    className="w-5 h-5 rounded-full"
                    onError={(e) => {
                      (e.target as HTMLImageElement).style.display = 'none';
                    }}
                  />
                  {cat.displayName}
                </button>
              ))}
            </div>
            {!detectiveCatId && <div className="text-xs text-ww-danger mt-2">请选择一只猫猫绑定视角</div>}
          </div>
        )}

        {/* Voice mode toggle + actions */}
        <div className="px-6 py-4 border-t border-ww-subtle flex items-center justify-between">
          <label className="flex items-center gap-2 text-sm text-ww-muted cursor-pointer">
            <input
              type="checkbox"
              checked={voiceMode}
              onChange={(e) => setVoiceMode(e.target.checked)}
              className="rounded border-ww-subtle"
            />
            语音模式
          </label>
          <div className="flex gap-3">
            <button
              onClick={onCancel}
              className="px-4 py-2 rounded-lg text-sm text-ww-muted hover:text-ww-main transition-colors"
            >
              取消
            </button>
            <button
              data-testid="lobby-confirm"
              onClick={handleConfirm}
              disabled={!canStart}
              className="px-6 py-2 rounded-lg text-sm font-semibold bg-ww-cute text-ww-base hover:brightness-90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              开始游戏
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
