'use client';

import { useRef } from 'react';
import type { CatData } from '@/hooks/useCatData';
import {
  CLIENT_OPTIONS,
  canonicalMentionPattern,
  type HubCatEditorFormState,
  joinTags,
  normalizeMentionPattern,
  splitMentionPatterns,
  splitStrengthTags,
} from './hub-cat-editor.model';
import { SectionCard, SelectField, TextField } from './hub-cat-editor-fields';
import type { ProfileItem } from './hub-provider-profiles.types';
import { TagEditor } from './hub-tag-editor';

type FormPatch = Partial<HubCatEditorFormState>;

function uniqueTags(tags: string[]): string[] {
  return Array.from(new Set(tags));
}

function currentAliasTags(form: HubCatEditorFormState, cat?: CatData | null): string[] {
  const raw = splitMentionPatterns(form.mentionPatterns).map(normalizeMentionPattern).filter(Boolean);
  const catId = cat?.id ?? form.catId.trim();
  const locked = catId ? [canonicalMentionPattern(catId)] : [];
  return uniqueTags([...locked, ...raw]);
}

export function IdentitySection({
  cat,
  form,
  avatarUploading,
  onChange,
  onAvatarUpload,
}: {
  cat?: CatData | null;
  form: HubCatEditorFormState;
  avatarUploading: boolean;
  onChange: (patch: FormPatch) => void;
  onAvatarUpload: (file: File) => Promise<void>;
}) {
  const strengthTags = splitStrengthTags(form.strengths);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  return (
    <SectionCard title="身份信息">
      {!cat ? (
        <div className="space-y-2">
          <TextField label="Cat ID" value={form.catId} onChange={(value) => onChange({ catId: value })} />
          <TextField
            label="Name"
            value={form.name}
            onChange={(value) => onChange({ name: value, displayName: value })}
          />
        </div>
      ) : (
        <TextField label="Name" value={form.name} onChange={(value) => onChange({ name: value, displayName: value })} />
      )}

      <TextField label="Nickname" value={form.nickname} onChange={(value) => onChange({ nickname: value })} />
      <TextField
        label="Description"
        value={form.roleDescription}
        onChange={(value) => onChange({ roleDescription: value })}
      />

      <div className="flex items-center gap-3">
        <span className="w-[140px] shrink-0 text-[13px] font-medium text-[#5C4B42]">Avatar</span>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-2 rounded-lg border border-[#E8DCCF] bg-[#F7F3F0] px-3 py-1.5 text-sm text-[#5C4B42] transition hover:border-[#D49266]"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#E8DCCF] bg-white text-[10px] text-[#8A776B]">
            {form.avatar ? (
              // biome-ignore lint/performance/noImgElement: avatar path may be runtime upload URL
              <img src={form.avatar} alt="Avatar preview" className="h-full w-full object-cover" />
            ) : (
              '🐱'
            )}
          </div>
          <span>{avatarUploading ? '上传中…' : '点击上传'}</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            void onAvatarUpload(file).finally(() => {
              if (fileInputRef.current) fileInputRef.current.value = '';
            });
          }}
        />
        <input
          aria-label="Avatar"
          value={form.avatar}
          onChange={(event) => onChange({ avatar: event.target.value })}
          className="sr-only"
        />
      </div>

      <div className="flex items-center gap-3">
        <span className="w-[140px] shrink-0 text-[13px] font-medium text-[#5C4B42]">Background Color</span>
        <div className="flex items-center gap-2">
          <label title="Primary">
            <input
              type="color"
              aria-label="Background Color Primary"
              value={form.colorPrimary}
              onChange={(event) => onChange({ colorPrimary: event.target.value })}
              className="h-8 w-8 cursor-pointer rounded border-0 bg-transparent p-0"
            />
          </label>
          <label title="Secondary">
            <input
              type="color"
              aria-label="Background Color Secondary"
              value={form.colorSecondary}
              onChange={(event) => onChange({ colorSecondary: event.target.value })}
              className="h-8 w-8 cursor-pointer rounded border-0 bg-transparent p-0"
            />
          </label>
        </div>
      </div>

      <TextField
        label="Team Strengths"
        value={form.teamStrengths}
        onChange={(value) => onChange({ teamStrengths: value })}
      />
      <TextField label="Personality" value={form.personality} onChange={(value) => onChange({ personality: value })} />
      <TextField
        label="Caution"
        value={form.caution}
        onChange={(value) => onChange({ caution: value })}
        placeholder="(无)"
      />

      <div className="flex items-start gap-3">
        <span className="w-[140px] shrink-0 pt-1 text-[13px] font-medium text-[#5C4B42]">Strengths</span>
        <div className="min-w-0 flex-1">
          <TagEditor
            tags={strengthTags}
            onChange={(tags) => onChange({ strengths: joinTags(tags) })}
            addLabel="+ 选择"
            placeholder="输入标签，例如 security"
            emptyLabel="(无)"
          />
        </div>
        <input
          aria-label="Strengths"
          value={form.strengths}
          onChange={(event) => onChange({ strengths: event.target.value })}
          className="sr-only"
        />
      </div>

      <div className="rounded-[10px] border border-dashed border-[#DCC9B8] bg-[#F7F3F0] px-3 py-2">
        <p className="text-[13px] font-semibold text-[#8A776B]">▸ Voice Config (点击展开)</p>
        <p className="mt-0.5 text-[11px] leading-4 text-[#B59A88]">需对接和启用语音功能后才支持配置</p>
      </div>
    </SectionCard>
  );
}

export function AccountSection({
  form,
  modelOptions,
  availableProfiles,
  loadingProfiles,
  onChange,
}: {
  form: HubCatEditorFormState;
  modelOptions: string[];
  availableProfiles: ProfileItem[];
  loadingProfiles: boolean;
  onChange: (patch: FormPatch) => void;
}) {
  const accountOptions = availableProfiles;

  return (
    <SectionCard title="认证与模型">
      <div className="space-y-2">
        <SelectField
          label="Client"
          value={form.client}
          options={CLIENT_OPTIONS}
          onChange={(value) => onChange({ client: value as HubCatEditorFormState['client'] })}
        />

        {form.client === 'antigravity' ? (
          <>
            <TextField
              label="CLI Command"
              value={form.commandArgs}
              onChange={(value) => onChange({ commandArgs: value })}
            />
            <TextField
              label="Model"
              value={form.defaultModel}
              onChange={(value) => onChange({ defaultModel: value })}
            />
          </>
        ) : (
          <>
            <SelectField
              label="Provider"
              value={form.accountRef}
              options={[
                { value: '', label: loadingProfiles ? '加载中…' : '请选择' },
                ...accountOptions.map((profile) => ({
                  value: profile.id,
                  label: profile.builtin ? `${profile.displayName}（内置）` : `${profile.displayName}（API Key）`,
                })),
              ]}
              onChange={(value) => onChange({ accountRef: value, defaultModel: '' })}
              disabled={loadingProfiles}
            />
            {modelOptions.length > 0 ? (
              <SelectField
                label="Model"
                value={form.defaultModel}
                options={modelOptions.map((model) => ({ value: model, label: model }))}
                onChange={(value) => onChange({ defaultModel: value })}
              />
            ) : (
              <TextField
                label="Model"
                value={form.defaultModel}
                onChange={(value) => onChange({ defaultModel: value })}
              />
            )}
          </>
        )}
      </div>
    </SectionCard>
  );
}

export function RoutingSection({
  cat,
  form,
  onChange,
}: {
  cat?: CatData | null;
  form: HubCatEditorFormState;
  onChange: (patch: FormPatch) => void;
}) {
  const aliases = currentAliasTags(form, cat);
  const catId = cat?.id ?? form.catId.trim();
  const lockedTags = catId ? [canonicalMentionPattern(catId)] : [];

  return (
    <SectionCard title="别名与 @ 路由">
      <TagEditor
        tags={aliases}
        lockedTags={lockedTags}
        onChange={(tags) => onChange({ mentionPatterns: joinTags(tags) })}
        addLabel="+ 添加"
        placeholder="@砚砚"
        emptyLabel="(暂无别名)"
      />
      <textarea
        aria-label="Aliases"
        value={form.mentionPatterns}
        onChange={(event) => onChange({ mentionPatterns: event.target.value })}
        placeholder="@codex, @缅因猫"
        className="sr-only"
      />
    </SectionCard>
  );
}
