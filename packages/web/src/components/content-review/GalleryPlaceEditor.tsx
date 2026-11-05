'use client';
import { useEffect, useRef, useState } from 'react';
import { useShellLanguage } from '@/components/shell/shell-language';

export interface GalleryPlaceEditorControl {
  readonly selectionId: string;
  readonly imageIndex: number;
  readonly words: string;
  readonly change: (words: string) => boolean;
  readonly finish: () => void;
  readonly cancel: () => void;
}

/** Optional local words, saved through the original composer as they are typed; this is not another draft. */
export function GalleryPlaceEditor({ editor }: { editor: GalleryPlaceEditorControl }) {
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, [editor.selectionId]);
  const english = useShellLanguage() === 'en';
  const [words, setWords] = useState(editor.words);
  const [refused, setRefused] = useState(false);
  return (
    <div className="space-y-2" data-gallery-input>
      <label className="block text-xs text-cafe-muted">
        {english
          ? `Artwork ${editor.imageIndex + 1} · Place ${editor.selectionId}`
          : `图 ${editor.imageIndex + 1} · 第 ${editor.selectionId} 处`}
        <textarea
          aria-label={english ? 'Words for this place' : '这处的话'}
          ref={input}
          maxLength={4000}
          rows={2}
          className="mt-1 block w-full resize-none rounded-lg border border-cafe-subtle bg-cafe-surface px-3 py-2 text-sm text-cafe-primary"
          placeholder={english ? 'Optional words · Enter to keep' : '写一句（可不写）· Enter 保留'}
          value={words}
          onChange={(event) => {
            const next = event.target.value;
            const accepted = editor.change(next);
            setRefused(!accepted);
            if (accepted) setWords(next);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              editor.cancel();
            } else if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              event.stopPropagation();
              editor.finish();
            }
          }}
        />
      </label>
      {refused ? (
        <p role="status" className="text-xs text-cafe-muted">
          {english
            ? 'These words could not be saved. Shorten them or finish the pending recall first.'
            : '这次输入尚未保存，请精简文字或先处理待确认的撤回。'}
        </p>
      ) : null}
      <div className="flex items-center justify-end gap-3 text-xs">
        <button type="button" onClick={editor.cancel} className="text-cafe-muted">
          {english ? 'Remove this place' : '取消这处'}
        </button>
        <button
          type="button"
          onClick={editor.finish}
          className="rounded-md bg-cafe-accent px-3 py-1 text-[var(--cafe-accent-foreground)]"
        >
          {english ? 'Keep' : '保留'}
        </button>
      </div>
    </div>
  );
}
