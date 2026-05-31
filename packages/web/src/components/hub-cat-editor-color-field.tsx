'use client';

import type { CSSProperties } from 'react';
import { hexToOklch } from '@/lib/color-utils';

const PREVIEW_MODES = [
  { mode: 'light', label: '浅色' },
  { mode: 'dark', label: '深色' },
] as const;

/**
 * 成员主色编辑（F056 单 hue 派生 / KD-18）。
 *
 * 用户只配一个主色 hex；气泡 light/dark × bubble/surface/text 全部由
 * cat-persona-tokens.css 的派生公式自动算。旧的 secondary 字段在气泡走
 * 派生后已失效，编辑器不再暴露（schema 仍保留，见 AC-E4）。下方双预览
 * 实时回显 light/dark 派生效果——改一个色，两个 mode 同步可见。
 */
export function CatColorField({ value, onChange }: { value: string; onChange: (hex: string) => void }) {
  /* F056 KD-18: guard against catalog entries with non-hex primary — schemas only
   * require a non-empty string, so manual edits / external API clients can persist
   * invalid values. Fall back to neutral hue/chroma instead of throwing during render. */
  let oklchHue = 297;
  let oklchChroma = 0.1;
  try {
    const { c, h } = hexToOklch(value);
    if (Number.isFinite(h) && Number.isFinite(c)) {
      oklchHue = h;
      oklchChroma = c;
    }
  } catch {
    /* invalid hex — keep neutral fallback; user can correct via picker */
  }
  const bubbleStyle = {
    '--msg-hue': oklchHue,
    '--msg-chroma': oklchChroma,
    background: 'var(--cat-msg-surface)',
    color: 'var(--cat-msg-text)',
  } as CSSProperties;

  return (
    <div className="flex items-center gap-[14px]">
      <span className="w-[150px] shrink-0 text-xs font-bold text-cafe-secondary">Background Color</span>
      <div className="flex items-center gap-3">
        <label className="flex items-center" title="主色">
          <input
            type="color"
            aria-label="Background Color Primary"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="h-6 w-6 cursor-pointer rounded border-0 bg-transparent p-0"
          />
        </label>
        <div className="flex items-center gap-2" aria-hidden>
          {PREVIEW_MODES.map(({ mode, label }) => (
            <div
              key={mode}
              className={`cat-persona-preview-${mode} flex h-7 w-[76px] items-center justify-center rounded-[9px]`}
              style={bubbleStyle}
              title={`${label}模式预览`}
            >
              <span className="text-label font-bold">喵～消息</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
