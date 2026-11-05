'use client';
import type { BackgroundPlacement, ChatBackgroundImageState as ChatBackgroundImage } from '@cat-cafe/shared';
import { useCafeTheme } from '@/hooks/useCafeTheme';
import { useShellCopy } from '../shell/shell-copy';
import { backgroundCopy } from './background-copy';

export function BackgroundImageControls({
  image,
  threadId,
  disabled,
  onChange,
  onPlacement,
}: {
  image: ChatBackgroundImage;
  threadId?: string;
  disabled: boolean;
  onChange(image: ChatBackgroundImage): Promise<void>;
  onPlacement(placement: BackgroundPlacement): Promise<void>;
}) {
  const copy = useShellCopy(backgroundCopy);
  const { resolvedTheme } = useCafeTheme();
  return (
    <>
      <div className="chat-background-control">
        <label htmlFor={`background-opacity-${threadId ?? 'global'}`}>{copy.opacity}</label>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <input
              id={`background-opacity-${threadId ?? 'global'}`}
              type="range"
              min="0"
              max="40"
              step="1"
              disabled={disabled}
              value={Math.round(image.opacity[resolvedTheme] * 100)}
              className="min-w-0 flex-1 accent-[var(--shell-primary)]"
              onChange={(event) =>
                void onChange({
                  ...image,
                  opacity: { ...image.opacity, [resolvedTheme]: Number(event.target.value) / 100 },
                  manualOpacity: { ...image.manualOpacity, [resolvedTheme]: true },
                })
              }
            />
            <output className="w-9 text-right tabular-nums">{Math.round(image.opacity[resolvedTheme] * 100)}%</output>
          </div>
          <p className="mt-2 text-xs" style={{ color: 'var(--shell-muted)' }}>
            {image.opacity[resolvedTheme] > (image.readableOpacity ?? image.recommendedOpacity)[resolvedTheme]
              ? copy.warning
              : copy.readable}
          </p>
        </div>
      </div>
      <div className="chat-background-control">
        <span>{copy.placement}</span>
        <fieldset aria-label={copy.placement} className="chat-background-placement">
          {(['fill', 'center', 'tile'] as const).map((placement) => (
            <button
              key={placement}
              type="button"
              disabled={disabled}
              aria-pressed={image.placement === placement}
              onClick={() => void onPlacement(placement)}
            >
              {copy[placement]}
            </button>
          ))}
        </fieldset>
      </div>
    </>
  );
}
