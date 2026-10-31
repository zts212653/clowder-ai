'use client';

import {
  type BackgroundPlacement,
  type ChatBackgroundState as ChatBackground,
  type ChatBackgroundImageState as ChatBackgroundImage,
  NO_CHAT_BACKGROUND,
  resolveChatBackgroundState as resolveChatBackground,
} from '@cat-cafe/shared';
import { useRef, useState } from 'react';
import { useActualColours } from '@/hooks/useActualColours';
import { AvatarImageWithFallback } from '../AvatarImageWithFallback';
import { uploadAvatarAsset } from '../hub-cat-editor.client';
import { useShellCopy } from '../shell/shell-copy';
import { BackgroundImageControls } from './BackgroundImageControls';
import { backgroundCopy } from './background-copy';
import { backgroundImagePreference } from './background-opacity';
import { sampleBackgroundOpacity } from './background-sampling';
import { useChatBackgroundPreferences } from './ChatBackgroundProvider';

export const BACKGROUND_ART = [
  { url: '/backgrounds/cafe-night.jpg', key: 'cafe', dark: true },
  { url: '/backgrounds/main-planet-study.jpg', key: 'study', dark: true },
  { url: '/backgrounds/sunset-clouds.jpg', key: 'sunset', dark: false },
] as const;

export function ChatBackgroundPicker({ threadId }: { threadId?: string }) {
  const copy = useShellCopy(backgroundCopy);
  const controller = useChatBackgroundPreferences();
  const actual = useActualColours();
  const [preparing, setPreparing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const selection = useRef(0);
  const current = controller ? resolveChatBackground(controller.preferences, threadId) : NO_CHAT_BACKGROUND;
  const image = current.kind === 'image' ? current : null;
  const disabled = !controller?.enabled || controller.loading || controller.loadError || preparing;
  const hasOverride = !!threadId && controller?.preferences.threads[threadId] !== undefined;
  const persist = async (background: ChatBackground | null) => {
    setError(null);
    const succeeded = await controller?.save({
      scope: threadId ? 'thread' : 'global',
      ...(threadId ? { threadId } : {}),
      background,
    });
    setError(succeeded ? null : copy.saveFailed);
  };
  const choose = async (
    url: string,
    name: string,
    placement: BackgroundPlacement = 'fill',
    previous?: ChatBackgroundImage,
  ) => {
    const ticket = ++selection.current;
    setPreparing(true);
    setError(null);
    try {
      const readableOpacity = await sampleBackgroundOpacity(url, placement, actual);
      if (ticket !== selection.current) return;
      await persist(backgroundImagePreference({ url, name, placement }, readableOpacity, previous));
    } catch {
      setError(copy.imageFailed);
    } finally {
      if (ticket === selection.current) setPreparing(false);
    }
  };
  const upload = async (file: File) => {
    setPreparing(true);
    setError(null);
    try {
      const url = await uploadAvatarAsset(file);
      await choose(url, file.name.slice(0, 160));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.imageFailed);
    } finally {
      setPreparing(false);
      if (input.current) input.current.value = '';
    }
  };
  const tile = (label: string, url: string | null, selected: boolean, onClick: () => void, hint?: string) => (
    <button
      key={url ?? label}
      type="button"
      className="chat-background-tile shell-focusable"
      aria-pressed={selected}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="chat-background-thumb" data-selected={selected || undefined}>
        {url ? (
          <AvatarImageWithFallback src={url} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="chat-background-empty" />
        )}
      </span>
      <span className="truncate">{label}</span>
      {hint && (
        <span className="text-micro" style={{ color: 'var(--shell-muted)' }}>
          {hint}
        </span>
      )}
    </button>
  );
  return (
    <div className="chat-background-picker" aria-busy={preparing || controller?.loading}>
      {controller?.enabled && controller.loadError && (
        <p role="alert">
          {copy.loadFailed}{' '}
          <button type="button" disabled={controller.loading || preparing} onClick={() => void controller.reload()}>
            {copy.retry}
          </button>
        </p>
      )}
      <fieldset className="chat-background-grid" aria-label={copy.title}>
        {tile(copy.none, null, current.kind === 'none', () => void persist(NO_CHAT_BACKGROUND))}
        {BACKGROUND_ART.map((art) =>
          tile(
            copy[art.key],
            art.url,
            image?.url === art.url,
            () => void choose(art.url, copy[art.key]),
            art.dark ? copy.dark : undefined,
          ),
        )}
        {image &&
          !BACKGROUND_ART.some((art) => art.url === image.url) &&
          tile(image.name, image.url, true, () => undefined)}
        <button
          type="button"
          className="chat-background-tile shell-focusable"
          disabled={disabled}
          onClick={() => input.current?.click()}
        >
          <span className="chat-background-thumb chat-background-upload" aria-hidden="true">
            +
          </span>
          <span>{copy.upload}</span>
        </button>
      </fieldset>
      <input
        ref={input}
        type="file"
        className="hidden"
        accept="image/png,image/jpeg,image/webp"
        aria-label={copy.upload}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void upload(file);
        }}
      />
      {image && (
        <BackgroundImageControls
          image={image}
          threadId={threadId}
          disabled={disabled}
          onChange={persist}
          onPlacement={(placement) => choose(image.url, image.name, placement, image)}
        />
      )}
      {threadId ? (
        <button
          type="button"
          className="mt-3 text-xs underline underline-offset-2"
          disabled={disabled || !hasOverride}
          onClick={() => void persist(null)}
        >
          {copy.inherit}
        </button>
      ) : (
        <p className="chat-background-separate">{copy.separate}</p>
      )}
      {(preparing || controller?.saving) && (
        <output className="mt-2 block text-xs">{preparing ? copy.uploading : copy.saving}</output>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-conn-red-text">
          {error}
        </p>
      )}
    </div>
  );
}

export function backgroundName(
  background: ChatBackground,
  copy: { none: string; cafe: string; study: string; sunset: string },
) {
  if (background.kind === 'none') return copy.none;
  const art = BACKGROUND_ART.find((entry) => entry.url === background.url);
  return art ? copy[art.key] : background.name;
}
