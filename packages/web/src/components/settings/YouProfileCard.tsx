'use client';

import { type FormEvent, useEffect, useRef, useState } from 'react';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import { CO_CREATOR_COLOR } from '@/lib/color-defaults';
import { apiFetch } from '@/utils/api-client';
import { AvatarImageWithFallback } from '../AvatarImageWithFallback';
import type { CoCreatorConfig } from '../config-viewer-types';
import { uploadAvatarAsset } from '../hub-cat-editor.client';
import { useShellCopy } from '../shell/shell-copy';
import { youSettingsCopy } from './you-settings-copy';

export function YouProfileCard({
  coCreator,
  loadError,
  reload,
}: {
  coCreator: CoCreatorConfig | null;
  loadError: boolean;
  reload(): Promise<void>;
}) {
  const copy = useShellCopy(youSettingsCopy);
  const [name, setName] = useState('');
  const [mentions, setMentions] = useState('');
  const [avatar, setAvatar] = useState('');
  const [primary, setPrimary] = useState(CO_CREATOR_COLOR.primary);
  const [secondary, setSecondary] = useState(CO_CREATOR_COLOR.secondary);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saved, setSaved] = useState(false);
  const [initializedFrom, setInitializedFrom] = useState<CoCreatorConfig | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!coCreator) return;
    setName(coCreator.name);
    setMentions(coCreator.mentionPatterns.join('  '));
    setAvatar(coCreator.avatar ?? '');
    setPrimary(coCreator.color?.primary ?? CO_CREATOR_COLOR.primary);
    setSecondary(coCreator.color?.secondary ?? CO_CREATOR_COLOR.secondary);
    setInitializedFrom(coCreator);
  }, [coCreator]);
  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    setSaved(false);
    try {
      setAvatar(await uploadAvatarAsset(file));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.failed);
    } finally {
      setUploading(false);
      if (input.current) input.current.value = '';
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!coCreator || saving) return;
    const mentionPatterns = [
      ...new Set(
        mentions
          .split(/[\s,，]+/)
          .filter(Boolean)
          .map((tag) => (tag.startsWith('@') ? tag : `@${tag}`)),
      ),
    ];
    if (!name.trim() || mentionPatterns.length === 0) {
      setError(copy.invalid);
      return;
    }
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      // This form owns the visible fields. The canonical writer preserves aliases/nickname from other editors.
      const response = await apiFetch('/api/config/co-creator', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          mentionPatterns,
          avatar: avatar || null,
          color: { primary, secondary },
        }),
      });
      if (!response.ok) throw new Error(copy.failed);
      const result = (await response.json()) as { config: { coCreator: CoCreatorConfig } };
      primeCoCreatorConfigCache(result.config.coCreator);
      await reload();
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : copy.failed);
    } finally {
      setSaving(false);
    }
  };
  return (
    <form className="you-settings-card" onSubmit={(event) => void submit(event)} onChange={() => setSaved(false)}>
      <div className="you-settings-card-heading">
        <h2>{copy.profile}</h2>
        <span>{copy.seen}</span>
      </div>
      {loadError ? (
        <p role="alert">
          {copy.loadFailed}{' '}
          <button type="button" onClick={() => void reload()}>
            {copy.retry}
          </button>
        </p>
      ) : null}
      <fieldset disabled={!coCreator || initializedFrom !== coCreator || saving || uploading || loadError}>
        <div className="you-profile-avatar-row">
          <span className="you-profile-avatar">
            {avatar ? (
              <AvatarImageWithFallback src={avatar} alt={name} className="h-full w-full object-cover" />
            ) : (
              name.slice(0, 1)
            )}
          </span>
          <button type="button" className="you-settings-button" onClick={() => input.current?.click()}>
            {uploading ? copy.uploading : copy.change}
          </button>
          {avatar && (
            <button
              type="button"
              className="you-settings-button"
              onClick={() => {
                setAvatar('');
                setSaved(false);
              }}
            >
              {copy.remove}
            </button>
          )}
          <input
            ref={input}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            aria-label={copy.change}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void upload(file);
            }}
          />
        </div>
        <label className="you-profile-field">
          <span>{copy.name}</span>
          <input value={name} onChange={(event) => setName(event.target.value)} required />
        </label>
        <div className="you-profile-field">
          <label htmlFor="you-mentions">{copy.mentions}</label>
          <div>
            <input id="you-mentions" value={mentions} onChange={(event) => setMentions(event.target.value)} required />
            <p>{copy.mentionHint}</p>
          </div>
        </div>
        <div className="you-profile-field">
          <span>{copy.color}</span>
          <div className="flex flex-wrap items-center gap-2">
            <input
              type="color"
              aria-label={copy.primary}
              value={primary.slice(0, 7)}
              onChange={(event) => setPrimary(event.target.value)}
            />
            <input
              type="color"
              aria-label={copy.secondary}
              value={secondary.slice(0, 7)}
              onChange={(event) => setSecondary(event.target.value)}
            />
            <span className="text-xs" style={{ color: 'var(--shell-muted)' }}>
              {copy.colorHint}
            </span>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3 pt-3">
          {saved && <output className="text-xs">{copy.saved}</output>}
          <button type="submit" className="you-settings-button you-settings-save">
            {saving ? copy.saving : copy.save}
          </button>
        </div>
      </fieldset>
      {error && (
        <p role="alert" className="mt-2 text-xs text-conn-red-text">
          {error}
        </p>
      )}
    </form>
  );
}
