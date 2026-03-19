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
          <TextField label="Name" value={form.name} onChange={(value) => onChange({ name: value })} />
          <TextField
            label="Display Name"
            value={form.displayName}
            onChange={(value) => onChange({ displayName: value })}
          />
        </div>
      ) : (
        <TextField label="Name" value={form.name} onChange={(value) => onChange({ name: value, displayName: value })} />
      )}

      <div className="space-y-2 rounded-[10px] border border-[#E8DCCF] bg-[#F7F3F0] px-4 py-3 sm:ml-[152px]">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-semibold text-[#8A776B]">Avatar</span>
          <span className="text-xs text-[#8A776B]">点击上传新头像覆盖</span>
        </div>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex w-full items-center gap-3 rounded-[10px] border border-[#E8DCCF] bg-white/90 p-3 text-left transition hover:border-[#D49266]"
        >
          <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#E8DCCF] bg-[#F7F3F0] text-xs text-[#8A776B]">
            {form.avatar ? (
              // biome-ignore lint/performance/noImgElement: avatar path may be runtime upload URL
              <img src={form.avatar} alt="Avatar preview" className="h-full w-full object-cover" />
            ) : (
              'Avatar'
            )}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-[#2D2118]">{avatarUploading ? '上传中…' : '点击上传头像'}</p>
            <p className="mt-1 text-xs text-[#8A776B]">支持 png / jpg / webp，上传后自动回填</p>
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

      <div className="space-y-2 rounded-[10px] border border-[#E8DCCF] bg-[#F7F3F0] px-4 py-3 sm:ml-[152px]">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[13px] font-semibold text-[#8A776B]">Background Color</span>
          <span className="text-xs text-[#8A776B]">点击调色盘</span>
        </div>
        <div className="space-y-2">
          <label className="flex items-center justify-between rounded-[10px] border border-[#E8DCCF] bg-white/90 px-3 py-2 text-[13px] text-[#5C4B42]">
            <span
              className="h-8 w-8 rounded-lg border border-white shadow-sm"
              style={{ backgroundColor: form.colorPrimary }}
            />
            <input
              type="color"
              aria-label="Background Color Primary"
              value={form.colorPrimary}
              onChange={(event) => onChange({ colorPrimary: event.target.value })}
              className="h-8 w-10 cursor-pointer rounded border-0 bg-transparent p-0"
            />
          </label>
          <label className="flex items-center justify-between rounded-[10px] border border-[#E8DCCF] bg-white/90 px-3 py-2 text-[13px] text-[#5C4B42]">
            <span
              className="h-8 w-8 rounded-lg border border-white shadow-sm"
              style={{ backgroundColor: form.colorSecondary }}
            />
            <input
              type="color"
              aria-label="Background Color Secondary"
              value={form.colorSecondary}
              onChange={(event) => onChange({ colorSecondary: event.target.value })}
              className="h-8 w-10 cursor-pointer rounded border-0 bg-transparent p-0"
            />
          </label>
        </div>
      </div>

      <div className="space-y-2">
        <TextField label="Nickname" value={form.nickname} onChange={(value) => onChange({ nickname: value })} />
        <TextField
          label="Description"
          value={form.roleDescription}
          onChange={(value) => onChange({ roleDescription: value })}
        />
        <TextField
          label="Team Strengths"
          value={form.teamStrengths}
          onChange={(value) => onChange({ teamStrengths: value })}
        />
        <TextField
          label="Personality"
          value={form.personality}
          onChange={(value) => onChange({ personality: value })}
        />
        <TextField
          label="Caution"
          value={form.caution}
          onChange={(value) => onChange({ caution: value })}
          placeholder="(无)"
        />
      </div>

      <div className="space-y-2 sm:ml-[152px]">
        <span className="text-[13px] font-semibold text-[#8A776B]">Strengths</span>
        <TagEditor
          tags={strengthTags}
          onChange={(tags) => onChange({ strengths: joinTags(tags) })}
          addLabel="+ 选择"
          placeholder="输入标签，例如 security"
          emptyLabel="(无)"
        />
        <input
          aria-label="Strengths"
          value={form.strengths}
          onChange={(event) => onChange({ strengths: event.target.value })}
          className="sr-only"
        />
      </div>

      <div className="rounded-[12px] border border-dashed border-[#DCC9B8] bg-[#F7F3F0] px-4 py-3 sm:ml-[152px]">
        <p className="text-[14px] font-semibold text-[#8A776B]">▸ Voice Config (点击展开)</p>
        <p className="mt-1 text-[11px] leading-5 text-[#B59A88]">需对接和启用语音功能后才支持配置</p>
      </div>
    </SectionCard>
  );
}

export function AccountSection({
  form,
  modelOptions,
  availableProfiles,
  selectedProfile,
  loadingProfiles,
  onChange,
}: {
  form: HubCatEditorFormState;
  modelOptions: string[];
  availableProfiles: ProfileItem[];
  selectedProfile: ProfileItem | null;
  loadingProfiles: boolean;
  onChange: (patch: FormPatch) => void;
}) {
  const accountOptions = availableProfiles;

  return (
    <SectionCard
      title="认证与模型"
      description="成员侧单独选择 client、绑定 provider、再选择模型。API Key provider 不和任何 client 预绑定，但 provider 本身维护可选模型列表。"
    >
      <p className="text-xs font-semibold leading-5 text-[#BF360C]">
        ⚠️ 约束：每个 client 只能选自己的内置账号，或任意独立 API Key 账号；不校验 API Key 账号是否真的兼容该 client。
      </p>
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
                { value: '', label: loadingProfiles ? '加载中…' : '未绑定' },
                ...accountOptions.map((profile) => ({
                  value: profile.id,
                  label: profile.builtin ? profile.displayName : `${profile.displayName}（API Key）`,
                })),
              ]}
              onChange={(value) => onChange({ accountRef: value })}
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
            {selectedProfile ? (
              <p className="text-[11px] leading-5 text-[#8A776B] sm:ml-[152px]">
                当前绑定账号：{selectedProfile.displayName}
                {selectedProfile.builtin ? '（内置 provider）' : '（独立 API Key provider）'}
              </p>
            ) : null}
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
    <SectionCard
      title="别名与 @ 路由"
      description="默认包含 @catId；前端自动 @ 仅提示首个 mention，后续别名仍可路由但不进入提示列表。唯一性校验自动进行。"
    >
      <div className="sm:ml-[152px]">
        <TagEditor
          tags={aliases}
          lockedTags={lockedTags}
          onChange={(tags) => onChange({ mentionPatterns: joinTags(tags) })}
          addLabel="+ 添加"
          placeholder="@砚砚"
          emptyLabel="(暂无别名)"
        />
      </div>
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
