'use client';
import { useEffect, useRef, useState } from 'react';
import { AvatarImageWithFallback } from '../../AvatarImageWithFallback';
import { uploadAvatarAsset } from '../../hub-cat-editor.client';
import type { HubCatEditorFormState } from '../../hub-cat-editor.model';
import type { MemberText } from './MemberRuntimeFields';

export function MemberBannerFields({
  form,
  patch,
  t,
  onUploadingChange,
}: {
  form: HubCatEditorFormState;
  patch(change: Partial<HubCatEditorFormState>): void;
  t: MemberText;
  onUploadingChange?(uploading: boolean): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    onUploadingChange?.(busy);
    return () => onUploadingChange?.(false);
  }, [busy, onUploadingChange]);
  const upload = async (file: File) => {
    setBusy(true);
    setError('');
    try {
      const banner = await uploadAvatarAsset(file);
      if (mounted.current) patch({ banner });
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : t('上传失败', 'Upload failed'));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section
      className="space-y-3 rounded-xl border border-[var(--console-border-soft)] p-4"
      aria-label={t('横幅', 'Banner')}
    >
      <h3 className="text-sm font-medium">{t('横幅', 'Banner')}</h3>
      <label className="flex items-center gap-3 text-sm">
        {t('颜色', 'Color')}
        <input
          type="color"
          value={form.colorPrimary}
          aria-label={t('成员主色', 'Member color')}
          onChange={(event) => patch({ colorPrimary: event.target.value })}
        />
      </label>
      {form.banner && (
        <div className="h-[104px] overflow-hidden rounded-lg" style={{ background: form.colorSecondary }}>
          <AvatarImageWithFallback
            src={form.banner}
            alt={t('横幅预览', 'Banner preview')}
            className="h-full w-full object-cover"
          />
        </div>
      )}
      <div className="flex items-center gap-3 text-sm">
        <span>{t('图片', 'Image')}</span>
        <button type="button" className="you-settings-button" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? t('上传中…', 'Uploading…') : t('上传图片', 'Upload image')}
        </button>
        {form.banner && (
          <button type="button" className="you-settings-button" disabled={busy} onClick={() => patch({ banner: '' })}>
            {t('移除', 'Remove')}
          </button>
        )}
        <input
          ref={input}
          type="file"
          className="hidden"
          accept="image/png,image/jpeg,image/webp"
          aria-label={t('上传横幅', 'Upload banner')}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.currentTarget.value = '';
            if (file) void upload(file);
          }}
        />
      </div>
      {error && (
        <p role="alert" className="text-xs text-conn-red-text">
          {error}
        </p>
      )}
    </section>
  );
}
