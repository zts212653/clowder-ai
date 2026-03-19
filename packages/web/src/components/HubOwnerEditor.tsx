'use client';

import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { OwnerConfig } from './config-viewer-types';
import { PersistenceBanner, SectionCard, TextField } from './hub-cat-editor-fields';
import { uploadAvatarAsset } from './hub-cat-editor.client';
import { TagEditor } from './hub-tag-editor';

const DEFAULT_OWNER: OwnerConfig = {
  name: 'Co-worker',
  aliases: [],
  mentionPatterns: ['@co-worker', '@owner'],
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

interface HubOwnerEditorProps {
  open: boolean;
  owner?: OwnerConfig | null;
  onClose: () => void;
  onSaved: () => Promise<void> | void;
}

export function HubOwnerEditor({ open, owner, onClose, onSaved }: HubOwnerEditorProps) {
  const currentOwner = owner ?? DEFAULT_OWNER;
  const [name, setName] = useState(currentOwner.name);
  const [avatar, setAvatar] = useState(currentOwner.avatar ?? '');
  const [colorPrimary, setColorPrimary] = useState(currentOwner.color?.primary ?? DEFAULT_OWNER.color!.primary);
  const [colorSecondary, setColorSecondary] = useState(currentOwner.color?.secondary ?? DEFAULT_OWNER.color!.secondary);
  const [aliases, setAliases] = useState<string[]>(currentOwner.aliases);
  const [mentionPatterns, setMentionPatterns] = useState<string[]>(currentOwner.mentionPatterns);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const nextOwner = owner ?? DEFAULT_OWNER;
    setName(nextOwner.name);
    setAvatar(nextOwner.avatar ?? '');
    setColorPrimary(nextOwner.color?.primary ?? DEFAULT_OWNER.color!.primary);
    setColorSecondary(nextOwner.color?.secondary ?? DEFAULT_OWNER.color!.secondary);
    setAliases(nextOwner.aliases);
    setMentionPatterns(nextOwner.mentionPatterns);
    setError(null);
  }, [open, owner]);

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
      setError('Owner 名称不能为空');
      return;
    }
    if (cleanedMentions.length === 0) {
      setError('至少保留一个可用的 @ 标签');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const res = await apiFetch('/api/config/owner', {
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
        className="w-full max-w-3xl rounded-[28px] border border-[#EFDCCB] bg-[#FDF8F3] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-[#F0DDCD] px-6 py-5">
          <div>
            <p className="text-xs font-semibold text-[#D18A61]">成员协作 &gt; 总览 &gt; Owner</p>
            <h3 className="mt-2 text-2xl font-bold text-[#2D2118]">编辑 Co-worker / Owner</h3>
            <p className="mt-1 text-sm text-[#8A776B]">可维护头像、别名、被 @ 标签与卡片背景色。</p>
          </div>
          <button type="button" onClick={onClose} className="text-2xl leading-none text-[#B59A88]" aria-label="关闭">
            ×
          </button>
        </div>

        <div className="space-y-4 px-6 py-5">
          <PersistenceBanner />

          <SectionCard title="Owner 身份">
            <div className="grid gap-4 md:grid-cols-[1.2fr_0.8fr]">
              <TextField label="Owner Name" value={name} onChange={setName} />

              <div className="rounded-[20px] border border-[#E8DCCF] bg-white/80 p-4">
                <div className="flex items-center gap-3">
                  <div
                    className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-full text-sm font-bold text-white"
                    style={{ backgroundColor: colorPrimary }}
                  >
                    {avatar ? (
                      // biome-ignore lint/performance/noImgElement: owner avatar may be runtime upload URL
                      <img src={avatar} alt="Owner avatar preview" className="h-full w-full object-cover" />
                    ) : (
                      'ME'
                    )}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold text-[#2D2118]">{name.trim() || 'Co-worker'}</p>
                    <p className="mt-1 text-xs text-[#8A776B]">{mentionPatterns.join('  ') || '@co-worker'}</p>
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-[#5C4B42]">Avatar</span>
                <span className="text-xs text-[#8A776B]">仅显示预览，不回填上传路径</span>
              </div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex w-full items-center gap-3 rounded-2xl border border-[#E8DCCF] bg-white/80 p-3 text-left transition hover:border-[#D49266]"
              >
                <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#E8DCCF] bg-[#F7F3F0] text-xs text-[#8A776B]">
                  {avatar ? (
                    // biome-ignore lint/performance/noImgElement: owner avatar may be runtime upload URL
                    <img src={avatar} alt="Owner avatar preview" className="h-full w-full object-cover" />
                  ) : (
                    'Avatar'
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium text-[#2D2118]">{uploadingAvatar ? '上传中…' : '点击上传头像'}</p>
                  <p className="mt-1 text-xs text-[#8A776B]">支持 png / jpg / webp，上传后仅显示头像预览</p>
                </div>
              </button>
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
              {avatar ? (
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={() => setAvatar('')}
                    className="rounded-full bg-[#F7F3F0] px-3 py-1.5 text-xs font-semibold text-[#8A776B] transition hover:bg-[#EFE5DD]"
                  >
                    清除头像
                  </button>
                </div>
              ) : null}
            </div>

            <div className="grid gap-3 md:grid-cols-2">
              <label className="flex items-center justify-between rounded-2xl border border-[#E8DCCF] bg-white/80 px-3 py-2.5 text-sm text-[#5C4B42]">
                <span className="font-medium">Primary</span>
                <div className="flex items-center gap-3">
                  <span className="h-8 w-8 rounded-lg border border-white shadow-sm" style={{ backgroundColor: colorPrimary }} />
                  <input
                    type="color"
                    aria-label="Owner Color Primary"
                    value={colorPrimary}
                    onChange={(event) => setColorPrimary(event.target.value)}
                    className="h-8 w-10 cursor-pointer rounded border-0 bg-transparent p-0"
                  />
                </div>
              </label>
              <label className="flex items-center justify-between rounded-2xl border border-[#E8DCCF] bg-white/80 px-3 py-2.5 text-sm text-[#5C4B42]">
                <span className="font-medium">Secondary</span>
                <div className="flex items-center gap-3">
                  <span
                    className="h-8 w-8 rounded-lg border border-white shadow-sm"
                    style={{ backgroundColor: colorSecondary }}
                  />
                  <input
                    type="color"
                    aria-label="Owner Color Secondary"
                    value={colorSecondary}
                    onChange={(event) => setColorSecondary(event.target.value)}
                    className="h-8 w-10 cursor-pointer rounded border-0 bg-transparent p-0"
                  />
                </div>
              </label>
            </div>
          </SectionCard>

          <SectionCard title="称呼与 @ 标签" description="这些标签会回写到 Owner 配置里，用于总览卡和路由识别。">
            <div className="space-y-2">
              <span className="text-sm font-medium text-[#5C4B42]">别名</span>
              <TagEditor
                tags={aliases}
                onChange={setAliases}
                addLabel="+ 添加别名"
                placeholder="例如 共创伙伴"
                emptyLabel="(无)"
                tone="orange"
              />
            </div>

            <div className="space-y-2">
              <span className="text-sm font-medium text-[#5C4B42]">Mention Tags</span>
              <TagEditor
                tags={mentionPatterns}
                onChange={(next) => setMentionPatterns(next.map(normalizeMentionTag).filter(Boolean))}
                addLabel="+ 添加标签"
                placeholder="@co-worker"
                emptyLabel="至少保留一个标签"
                tone="green"
                normalize={normalizeMentionTag}
              />
            </div>
          </SectionCard>

          {error ? <p className="rounded-2xl bg-red-50 px-4 py-3 text-sm text-red-600">{error}</p> : null}
        </div>

        <div className="flex items-center justify-between border-t border-[#F0DDCD] bg-[#FFF3EA] px-6 py-4">
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
            {saving ? '保存中...' : '保存 Owner'}
          </button>
        </div>
      </div>
    </div>
  );
}
