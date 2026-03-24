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
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 px-4" onClick={onClose}>
      <div
        className="flex max-h-[88vh] w-full max-w-3xl flex-col rounded-[28px] border border-[#EFDCCB] bg-[#FDF8F3] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between border-b border-[#F0DDCD] px-6 py-5">
          <div>
            <p className="text-xs font-semibold text-[#D18A61]">成员协作 &gt; 总览 &gt; {current.name}</p>
            <h3 className="mt-2 text-2xl font-bold text-[#2D2118]">编辑 {current.name}</h3>
            <p className="mt-1 text-sm text-[#8A776B]">可维护头像、别名、被 @ 标签与卡片背景色。</p>
          </div>
          <button type="button" onClick={onClose} className="text-2xl leading-none text-[#B59A88]" aria-label="关闭">
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-5">
          <PersistenceBanner />

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
              <span className="w-[140px] shrink-0 text-[13px] font-medium text-[#5C4B42]">Avatar</span>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 rounded-lg border border-[#E8DCCF] bg-[#F7F3F0] px-3 py-1.5 text-sm text-[#5C4B42] transition hover:border-[#D49266]"
              >
                <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#E8DCCF] bg-white text-[10px] text-[#8A776B]">
                  {avatar ? (
                    // biome-ignore lint/performance/noImgElement: co-creator avatar may be runtime upload URL
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
                  className="text-xs text-[#8A776B] hover:text-[#E29578]"
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
              <span className="w-[140px] shrink-0 text-[13px] font-medium text-[#5C4B42]">Background Color</span>
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
              <span className="w-[140px] shrink-0 pt-1 text-[13px] font-medium text-[#5C4B42]">别名</span>
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
              <span className="w-[140px] shrink-0 pt-1 text-[13px] font-medium text-[#5C4B42]">@ 标签</span>
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

          {error ? <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p> : null}
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-[#F0DDCD] bg-[#FFF3EA] px-6 py-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl bg-white px-4 py-2 text-sm text-[#6A5A50] transition hover:bg-[#F7EEE6]"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded-xl bg-[#D49266] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#C88254] disabled:opacity-50"
          >
            {saving ? '保存中...' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
