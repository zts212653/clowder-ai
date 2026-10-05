import type { ImmutableMedia } from '@cat-cafe/shared';
import { useEffect, useRef } from 'react';
import type { MediaPoint } from './review-geometry';
import type { ReviewMarkupFrame } from './review-markup-draft';

export type InlineTextDraft = {
  at: MediaPoint;
  value: string;
  originalId?: string;
  frame?: ReviewMarkupFrame;
  moving?: boolean;
};

export function ReviewMarkupTextEditor({
  editor,
  media,
  screenScale,
  notice,
  onChange,
  onComplete,
  onNotice,
}: {
  editor: InlineTextDraft;
  media: Pick<ImmutableMedia, 'width' | 'height'>;
  screenScale: number;
  notice: string | null;
  onChange: (editor: InlineTextDraft) => void;
  onComplete: () => void;
  onNotice: (message: string) => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => input.current?.focus(), []);
  return (
    <div
      className="absolute z-[4] max-w-[calc(100%-16px)] rounded-xl border border-cafe-accent bg-cafe-surface p-2 shadow-lg"
      style={{
        left: Math.max(8, Math.min(editor.at.x * screenScale, media.width * screenScale - 320)),
        top: Math.max(8, Math.min(editor.at.y * screenScale, media.height * screenScale - 118)),
        width: Math.min(320, media.width * screenScale - 16),
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <textarea
        ref={input}
        aria-label="标注文字"
        value={editor.value}
        maxLength={240}
        rows={2}
        className="w-full resize-none bg-transparent text-base text-cafe outline-none"
        placeholder="在这里写标注文字"
        onChange={(event) => onChange({ ...editor, value: event.target.value })}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            onComplete();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            if (editor.value.trim()) onNotice('文字草稿仍在这里；完成文字后才会加入待保存标记。');
            else onComplete();
          }
        }}
      />
      <div className="flex items-center justify-end gap-2 text-xs">
        {editor.originalId ? (
          <button type="button" onClick={() => onChange({ ...editor, moving: true })}>
            移动文字
          </button>
        ) : null}
        <button type="button" className="font-semibold text-cafe-accent" onClick={onComplete}>
          完成文字
        </button>
      </div>
      {notice ? <output className="text-xs text-cafe-muted">{notice}</output> : null}
    </div>
  );
}
