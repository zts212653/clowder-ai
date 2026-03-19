'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTts } from '@/hooks/useTts';
import { useBrakeStore } from '@/stores/brakeStore';
import { CatAvatar } from './CatAvatar';

/** Three-cat 撒娇 messages by level */
const MESSAGES: Record<1 | 2 | 3, { catId: string; nickname: string; text: string }[]> = {
  1: [
    { catId: 'opus', nickname: '宪宪', text: '铲屎官，你忙很久啦，要不要喝口水呀？喵~' },
    { catId: 'codex', nickname: '砚砚', text: '监测到当前任务已持续较久。建议进行 5min 视疲劳缓解。' },
    { catId: 'gemini', nickname: '烁烁', text: '嘿！你得先站起来伸个懒腰！' },
  ],
  2: [
    { catId: 'opus', nickname: '宪宪', text: '宪宪觉得你现在的效率有点下降哦，休息一下下，回来肯定写得更棒！' },
    { catId: 'codex', nickname: '砚砚', text: '逻辑链路已过载。现在强行推进会增加 bug 率。请离线冷却。' },
    { catId: 'gemini', nickname: '烁烁', text: '你的 hyperfocus 模式开启太久啦，快去窗口吹吹风喵！' },
  ],
  3: [
    { catId: 'opus', nickname: '宪宪', text: '(蹭蹭) 我不管，现在键盘是我的地盘了。除非你陪我玩 5 分钟！' },
    { catId: 'codex', nickname: '砚砚', text: '警告：由于你多次无视建议，请执行 Check-in 协议。' },
    { catId: 'gemini', nickname: '烁烁', text: '(在屏幕上跳舞) 只有出去走走才能重新连接灵感！去嘛去嘛~' },
  ],
};

const LEVEL_STYLE: Record<1 | 2 | 3, { border: string; bg: string; title: string }> = {
  1: { border: 'border-amber-300', bg: 'bg-amber-50', title: '休息时间到啦！' },
  2: { border: 'border-orange-400', bg: 'bg-orange-50', title: '猫猫们有点担心你了！' },
  3: { border: 'border-red-400', bg: 'bg-red-50', title: '三猫紧急拦截！' },
};

const NIGHT_STYLE = { border: 'border-indigo-300', bg: 'bg-indigo-50/80' };

/** Compact urgency badge for avatar corner (emoji-free) */
const CAT_ALERT_BADGE: Record<1 | 2 | 3, string> = {
  1: 'L1',
  2: 'L2',
  3: 'L3',
};

export function BrakeModal() {
  const { visible, level, activeMinutes, nightMode, submitting, checkin, bypassDisabled } = useBrakeStore();
  const { synthesize, state: ttsState } = useTts();
  const [showReason, setShowReason] = useState(false);
  const [reason, setReason] = useState('');
  const lastTriggerRef = useRef<number>(0);

  // Reset local state when modal opens
  useEffect(() => {
    if (visible) {
      setShowReason(false);
      setReason('');
    }
  }, [visible]);

  // AC29: Auto-play TTS on modal show
  useEffect(() => {
    if (!visible || !level) return;
    const triggerId = Date.now();
    // Dedup: skip if triggered within 2 seconds (same event)
    if (triggerId - lastTriggerRef.current < 2000) return;
    lastTriggerRef.current = triggerId;

    // Play first cat's message
    const msg = MESSAGES[level]?.[0];
    if (msg) {
      synthesize(`brake-${triggerId}`, msg.text, msg.catId);
    }
  }, [visible, level, synthesize]);

  // Escape to dismiss (only rest — safest option)
  useEffect(() => {
    if (!visible) return;
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') checkin('rest');
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [visible, checkin]);

  const handleContinue = useCallback(() => {
    if (!showReason) {
      setShowReason(true);
      return;
    }
    if (reason.trim()) {
      checkin('continue', reason.trim());
    }
  }, [showReason, reason, checkin]);

  const handleTtsRetry = useCallback(() => {
    const msg = MESSAGES[level]?.[0];
    if (msg) {
      synthesize(`brake-retry-${Date.now()}`, msg.text, msg.catId);
    }
  }, [level, synthesize]);

  if (!visible) return null;

  const style = LEVEL_STYLE[level];
  const messages = MESSAGES[level];
  const borderClass = nightMode ? NIGHT_STYLE.border : style.border;
  const bgClass = nightMode ? NIGHT_STYLE.bg : style.bg;
  const alertBadge = CAT_ALERT_BADGE[level];

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: modal content trap */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape handled globally */}
      <div
        className={`${bgClass} ${borderClass} border-2 rounded-2xl shadow-2xl max-w-md w-full p-6 space-y-4`}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="text-center">
          <h2 className={`text-lg font-bold ${nightMode ? 'text-indigo-200' : ''}`}>
            {nightMode ? '深夜了，猫猫们想你休息' : style.title}
          </h2>
          <p className="text-sm text-gray-500 mt-1">已专注工作 {activeMinutes} 分钟</p>
        </div>

        {/* Cat messages (AC30: enlarged avatars + urgency badge) */}
        <div className="space-y-3">
          {messages.map((msg) => (
            <div key={msg.catId} className="flex items-start gap-3">
              <div className="relative shrink-0">
                <CatAvatar catId={msg.catId} size={48} />
                <span className="absolute -bottom-1 -right-1 text-[10px] px-1 py-0.5 rounded bg-white/90 border border-gray-200">
                  {alertBadge}
                </span>
              </div>
              <div className="flex-1 min-w-0">
                <span className="text-xs font-semibold text-gray-600">{msg.nickname}</span>
                <p className="text-sm text-gray-700 mt-0.5">{msg.text}</p>
              </div>
            </div>
          ))}
        </div>

        {/* AC29: TTS autoplay fallback */}
        {ttsState === 'error' && (
          <button
            type="button"
            onClick={handleTtsRetry}
            className="w-full text-xs text-gray-500 hover:text-gray-700 underline py-1"
          >
            点击播放猫猫语音
          </button>
        )}

        {/* Continue reason input */}
        {showReason && (
          <div className="space-y-2">
            {/* biome-ignore lint/a11y/noLabelWithoutControl: label wraps adjacent input */}
            <label className="text-xs text-gray-500">为什么需要继续？（必填）</label>
            <input
              ref={(el) => el?.focus()}
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="例：正在修复线上 P0 故障"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-amber-300"
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === 'Enter' && reason.trim()) handleContinue();
              }}
            />
          </div>
        )}

        {/* Actions */}
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => checkin('rest')}
            disabled={submitting}
            className="w-full py-2.5 rounded-xl text-sm font-medium text-white bg-green-500 hover:bg-green-600 transition-colors disabled:opacity-50"
          >
            立刻休息（5 分钟）
          </button>
          <button
            type="button"
            onClick={() => checkin('wrap_up')}
            disabled={submitting}
            className="w-full py-2.5 rounded-xl text-sm font-medium text-white bg-amber-500 hover:bg-amber-600 transition-colors disabled:opacity-50"
          >
            收尾（10 分钟）
          </button>
          {!bypassDisabled && (
            <button
              type="button"
              onClick={handleContinue}
              disabled={submitting || (showReason && !reason.trim())}
              className="w-full py-2 rounded-xl text-sm text-gray-500 hover:bg-gray-100 transition-colors disabled:opacity-50"
            >
              {showReason ? '确认继续' : '我有紧急情况（需要理由）'}
            </button>
          )}
          {bypassDisabled && (
            <p className="text-center text-xs text-red-400 py-1">
              紧急跳过次数已用完（4 小时内 3 次），请选择休息或收尾
            </p>
          )}
        </div>

        {/* Footer */}
        <p className="text-center text-xs text-gray-400">
          {nightMode ? '深夜了，身体比代码更重要喵~' : '适当的暂停是为了更好的出发喵~'}
        </p>
      </div>
    </div>
  );
}
