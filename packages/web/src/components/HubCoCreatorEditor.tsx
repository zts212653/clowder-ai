'use client';

import { useEffect, useRef, useState } from 'react';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import { apiFetch } from '@/utils/api-client';
import type { CoCreatorConfig } from './config-viewer-types';
import { uploadAvatarAsset } from './hub-cat-editor.client';
import { PersistenceBanner, SectionCard, TextField } from './hub-cat-editor-fields';
import { TagEditor } from './hub-tag-editor';

const DEFAULT_CO_CREATOR: CoCreatorConfig = {
  name: 'ME',
  aliases: [],
  mentionPatterns: ['@co-creator'],
  avatar: '',
  color: {
    primary: '#D4A76A',
    secondary: '#FFF8F0',
  },
};

function normalizeMentionTag(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.startsWith('@') ? trimmed : `@${trimmed}`;
}

function uniqueTags(tags: string[]): string[] {
  return Array.from(new Set(tags.filter(Boolean)));
}

interface HubCoCreatorEditorProps {
  open: boolean;
  coCreator?: CoCreatorConfig | null;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}

export function HubCoCreatorEditor({ open, coCreator, onClose, onSaved }: HubCoCreatorEditorProps) {
  const current = coCreator ?? DEFAULT_CO_CREATOR;
  const [name, setName] = useState(current.name);
  const [avatar, setAvatar] = useState(current.avatar ?? '');
  const [colorPrimary, setColorPrimary] = useState(current.color?.primary ?? DEFAULT_CO_CREATOR.color!.primary);
  const [colorSecondary, setColorSecondary] = useState(current.color?.secondary ?? DEFAULT_CO_CREATOR.color!.secondary);
  const [aliases, setAliases] = useState<string[]>(current.aliases);
  const [mentionPatterns, setMentionPatterns] = useState<string[]>(current.mentionPatterns);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const next = coCreator ?? DEFAULT_CO_CREATOR;
    setName(next.name);
    setAvatar(next.avatar ?? '');
    setColorPrimary(next.color?.primary ?? DEFAULT_CO_CREATOR.color!.primary);
    setColorSecondary(next.color?.secondary ?? DEFAULT_CO_CREATOR.color!.secondary);
    setAliases(next.aliases);
    setMentionPatterns(next.mentionPatterns);
    setError(null);
  }, [open, coCreator]);

  if (!open) return null;

  const handleAvatarUpload = async (file: File) => {
    setUploadingAvatar(true);
    setError(null);
    try {
      setAvatar(await uploadAvatarAsset(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : '头像上传失败');
    } finally {
      setUploadingAvatar(false);
    }
  };

  const handleSave = async () => {
    const cleanedName = name.trim();
    const cleanedMentions = uniqueTags(mentionPatterns.map(normalizeMentionTag));
    if (!cleanedName) {
      setError('Co-Creator 名称不能为空');
      return;
    }
    if (cleanedMentions.length === 0) {
      setError('至少保留一个可用的 @ 标签');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch('/api/config/co-creator', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: cleanedName,
          aliases: uniqueTags(aliases.map((alias) => alias.trim())),
          mentionPatterns: cleanedMentions,
          avatar: avatar.trim() || null,
          color: {
            primary: colorPrimary,
            secondary: colorSecondary,
          },
        }),
      });
      if (!res.ok) {
        const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        setError((payload.error as string) ?? `保存失败 (${res.status})`);
        return;
      }
      primeCoCreatorConfigCache({
        name: cleanedName,
        aliases: uniqueTags(aliases.map((alias) => alias.trim())),
        mentionPatterns: cleanedMentions,
        avatar: avatar.trim() || '',
        color: {
          primary: colorPrimary,
          secondary: colorSecondary,
        },
      });
      await onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-[var(--console-overlay-medium)] px-4"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-full max-w-[560px] flex-col overflow-hidden rounded-[28px] bg-[var(--console-card-bg)] shadow-[0_22px_48px_rgba(43,33,26,0.13)]"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between px-7 py-5">
          <p className="text-[13px] font-extrabold text-[var(--console-modal-title)]">{current.name}</p>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-[var(--console-modal-close-bg)] text-lg font-extrabold leading-none text-[var(--console-modal-close-fg)] transition hover:opacity-80"
            aria-label="关闭"
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-7 py-5">
          <SectionCard title="身份信息">
            <TextField
              label="名称"
              ariaLabel="Owner Name"
              value={name}
              onChange={setName}
              required
              placeholder="Owner 显示名称"
            />

            <div className="flex items-center gap-3">
              <span className="w-[150px] shrink-0 text-[12px] font-bold text-cafe-secondary">Avatar</span>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 rounded-lg border border-[var(--console-border-soft)] bg-[var(--console-pill-bg)] px-3 py-1.5 text-sm text-cafe-secondary transition hover:border-[var(--cafe-accent)]"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[var(--console-border-soft)] bg-cafe-surface text-[10px] text-cafe-muted">
                  {avatar ? (
                    // biome-ignore lint/performance/noImgElement: co-creator avatar may be runtime upload URL
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={avatar} alt="Owner avatar preview" className="h-full w-full object-cover" />
                  ) : (
                    'ME'
                  )}
                </div>
                <span>{uploadingAvatar ? '上传中…' : '点击上传'}</span>
              </button>
              {avatar ? (
                <button
                  type="button"
                  onClick={() => setAvatar('')}
                  className="text-xs text-cafe-muted hover:text-conn-amber-text"
                >
                  清除
                </button>
              ) : null}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  void handleAvatarUpload(file).finally(() => {
                    if (fileInputRef.current) fileInputRef.current.value = '';
                  });
                }}
              />
            </div>

            <div className="flex items-center gap-3">
              <span className="w-[150px] shrink-0 text-[12px] font-bold text-cafe-secondary">Background Color</span>
              <div className="flex items-center gap-2">
                <label title="Primary">
                  <input
                    type="color"
                    aria-label="Owner Color Primary"
                    value={colorPrimary}
                    onChange={(event) => setColorPrimary(event.target.value)}
                    className="h-8 w-8 cursor-pointer rounded border-0 bg-transparent p-0"
                  />
                </label>
                <label title="Secondary">
                  <input
                    type="color"
                    aria-label="Owner Color Secondary"
                    value={colorSecondary}
                    onChange={(event) => setColorSecondary(event.target.value)}
                    className="h-8 w-8 cursor-pointer rounded border-0 bg-transparent p-0"
                  />
                </label>
              </div>
            </div>
          </SectionCard>

          <SectionCard title="别名与 @ 路由">
            <div className="flex items-start gap-3">
              <span className="w-[150px] shrink-0 pt-1 text-[12px] font-bold text-cafe-secondary">别名</span>
              <div className="min-w-0 flex-1">
                <TagEditor
                  tags={aliases}
                  onChange={setAliases}
                  addLabel="+ 添加"
                  placeholder="例如 共创伙伴"
                  emptyLabel="(无)"
                  tone="orange"
                />
              </div>
            </div>

            <div className="flex items-start gap-3">
              <span className="w-[150px] shrink-0 pt-1 text-[12px] font-bold text-cafe-secondary">@ 标签</span>
              <div className="min-w-0 flex-1">
                <TagEditor
                  tags={mentionPatterns}
                  onChange={(next) => setMentionPatterns(next.map(normalizeMentionTag).filter(Boolean))}
                  addLabel="+ 添加"
                  placeholder="@co-creator"
                  emptyLabel="(至少保留 1 个，否则无法 @)"
                  tone="green"
                  normalize={normalizeMentionTag}
                  minCount={1}
                />
              </div>
            </div>
          </SectionCard>

          <PersistenceBanner />
          {error ? <p className="rounded-2xl bg-conn-red-bg px-4 py-3 text-sm text-conn-red-text">{error}</p> : null}
          <div className="flex items-center justify-end pt-4">
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="h-8 rounded-[10px] bg-[var(--cafe-accent)] px-4 text-[13px] font-extrabold text-[var(--cafe-surface)] transition hover:bg-[var(--cafe-accent-hover)] disabled:opacity-50"
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
