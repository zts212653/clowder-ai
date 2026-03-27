'use client';

import { useMemo, useRef } from 'react';
import type { CatData } from '@/hooks/useCatData';
import {
  CLIENT_OPTIONS,
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

function safeAvatarSrc(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/uploads/') || trimmed.startsWith('/avatars/')) return trimmed;
  return null;
}

function autoSlug(name: string, currentId?: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^[^a-z]+/, '')
    .replace(/-+$/, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 40);

  if (/^[a-z]/.test(slug)) return slug;

  // Non-ASCII name: keep existing random ID if present
  if (currentId && /^cat-[a-z0-9]+$/.test(currentId)) return currentId;

  const rand = Math.random().toString(36).substring(2, 10);
  return `cat-${rand}`;
}

function currentAliasTags(form: HubCatEditorFormState): string[] {
  return splitMentionPatterns(form.mentionPatterns).map(normalizeMentionPattern).filter(Boolean);
}

export function IdentitySection({
  cat,
  form,
  hasError,
  avatarUploading,
  onChange,
  onAvatarUpload,
}: {
  cat?: CatData | null;
  form: HubCatEditorFormState;
  hasError?: boolean;
  avatarUploading: boolean;
  onChange: (patch: FormPatch) => void;
  onAvatarUpload: (file: File) => Promise<void>;
}) {
  const strengthTags = splitStrengthTags(form.strengths);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const avatarSrc = safeAvatarSrc(form.avatar);

  return (
    <SectionCard title="身份信息" tone={hasError ? 'error' : 'neutral'}>
      {!cat ? (
        <>
          <TextField
            label="名称"
            ariaLabel="Name"
            value={form.name}
            onChange={(value) => {
              onChange({ name: value, displayName: value, catId: autoSlug(value, form.catId) });
            }}
            required
            placeholder="成员显示名称，如 我的助手"
          />
          <input type="hidden" aria-label="Cat ID" value={form.catId} />
        </>
      ) : (
        <TextField
          label="名称"
          ariaLabel="Name"
          value={form.name}
          onChange={(value) => onChange({ name: value, displayName: value })}
        />
      )}

      <TextField
        label="昵称"
        ariaLabel="Nickname"
        value={form.nickname}
        onChange={(value) => onChange({ nickname: value })}
        placeholder="可选，铲屎官给的昵称"
      />
      <TextField
        label="角色描述"
        ariaLabel="Description"
        value={form.roleDescription}
        onChange={(value) => onChange({ roleDescription: value })}
        required
        placeholder="角色定位，如 代码审查专家"
      />

      <div className="flex items-center gap-3">
        <span className="w-[140px] shrink-0 text-[13px] font-medium text-[#5C4B42]">Avatar</span>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-2 rounded-lg border border-[#E8DCCF] bg-[#F7F3F0] px-3 py-1.5 text-sm text-[#5C4B42] transition hover:border-[#D49266]"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-[#E8DCCF] bg-white text-[10px] text-[#8A776B]">
            {avatarSrc ? (
              // biome-ignore lint/performance/noImgElement: avatar path may be runtime upload URL
              <img src={avatarSrc} alt="Avatar preview" className="h-full w-full object-cover" />
            ) : (
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24" role="img" aria-label="Default avatar">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2Zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8Zm-2-9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm4 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" />
              </svg>
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
        label="擅长领域"
        ariaLabel="Team Strengths"
        value={form.teamStrengths}
        onChange={(value) => onChange({ teamStrengths: value })}
        placeholder="如 架构设计、安全分析"
      />
      <TextField
        label="性格特征"
        ariaLabel="Personality"
        value={form.personality}
        onChange={(value) => onChange({ personality: value })}
        placeholder="如 温柔但有主见"
      />
      <TextField
        label="注意事项"
        ariaLabel="Caution"
        value={form.caution}
        onChange={(value) => onChange({ caution: value })}
        placeholder="可选，留空表示无特殊注意"
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

/** Well-known OpenCode provider names (always shown as suggestions). */
const KNOWN_OC_PROVIDERS = ['anthropic', 'openai', 'openrouter', 'google', 'azure', 'deepseek'];

/** Merge well-known providers with any prefixes extracted from model strings like "openai/gpt-5.4". */
function buildProviderSuggestions(models: string[]): string[] {
  const seen = new Set<string>(KNOWN_OC_PROVIDERS);
  for (const m of models) {
    const idx = m.indexOf('/');
    if (idx > 0) seen.add(m.slice(0, idx));
  }
  return [...seen].sort();
}

function ComboField({
  label,
  ariaLabel,
  value,
  onChange,
  suggestions,
  required = false,
  placeholder,
}: {
  label: string;
  ariaLabel?: string;
  value: string;
  onChange: (value: string) => void;
  suggestions: string[];
  required?: boolean;
  placeholder?: string;
}) {
  const listId = `combo-${label.replace(/\s+/g, '-').toLowerCase()}`;
  return (
    <label className="flex flex-col gap-1.5 text-[#5C4B42] sm:flex-row sm:items-center sm:gap-3">
      <span className="text-[13px] font-semibold text-[#8A776B] sm:w-[140px] sm:shrink-0">
        {label}
        {required && <span className="ml-0.5 text-[#E29578]">*</span>}
      </span>
      <div className="min-w-0 flex-1">
        <input
          aria-label={ariaLabel ?? label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          list={listId}
          className="w-full rounded-[10px] border border-[#E8DCCF] bg-[#F7F3F0] px-3.5 py-2 text-[14px] leading-5 text-[#2D2118] placeholder:text-[#C4B5A8] outline-none transition focus:border-[#D49266] focus:ring-2 focus:ring-[#F5D2B8]"
          placeholder={placeholder}
        />
        <datalist id={listId}>
          {suggestions.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      </div>
    </label>
  );
}

// Generate a hint showing what API endpoint the CLI will actually call
function buildCallHint(client: string, profile: ProfileItem | undefined, model: string): string | null {
  if (!profile || profile.builtin || !profile.baseUrl) return null;
  const base = profile.baseUrl.replace(/\/+$/, '');
  const hasV1Suffix = /\/v1$/i.test(base);

  // Claude CLI internally adds /v1, so if user already has /v1 it will become /v1/v1
  const cliEndpoints: Record<string, { cli: string; pathSuffix: string }> = {
    anthropic: { cli: 'claude', pathSuffix: '/v1/messages' },
    opencode: { cli: 'opencode', pathSuffix: '/messages' },
    openai: { cli: 'codex', pathSuffix: '/responses' },
    google: { cli: 'gemini', pathSuffix: `/models/${model || '...'}:generateContent` },
    dare: { cli: 'dare', pathSuffix: '/chat/completions' },
  };
  const info = cliEndpoints[client];
  if (!info) return null;

  const fullUrl = `${base}${info.pathSuffix}`;
  let warning = '';
  if (client === 'anthropic' && hasV1Suffix) {
    warning = `\n注意: base URL 末尾的 /v1 会导致路径重复（/v1/v1/messages），建议去掉 /v1 后缀`;
  }
  if (client === 'google') {
    warning = `\n注意: Gemini CLI 不支持自定义 API 端点，只能调用 Google 官方 API。如需使用第三方代理（如 OpenRouter），请改用 OpenCode 或 Claude 作为 Client`;
  }
  return `${info.cli} CLI 实际调用: ${fullUrl}${warning}`;
}

export function AccountSection({
  form,
  hasError,
  modelOptions,
  availableProfiles,
  loadingProfiles,
  onChange,
}: {
  form: HubCatEditorFormState;
  hasError?: boolean;
  modelOptions: string[];
  availableProfiles: ProfileItem[];
  loadingProfiles: boolean;
  onChange: (patch: FormPatch) => void;
}) {
  const accountOptions = availableProfiles;
  const selectedProfile = availableProfiles.find((p) => p.id === form.accountRef);
  const callHint = buildCallHint(form.client, selectedProfile, form.defaultModel);
  const providerSuggestions = useMemo(
    () => buildProviderSuggestions(selectedProfile?.models ?? []),
    [selectedProfile?.models],
  );

  return (
    <SectionCard title="认证与模型" tone={hasError ? 'error' : 'neutral'}>
      <div className="space-y-2">
        <SelectField
          label="Client"
          value={form.client}
          options={CLIENT_OPTIONS}
          onChange={(value) => onChange({ client: value as HubCatEditorFormState['client'], ocProviderName: '' })}
          required
        />

        {form.client === 'antigravity' ? (
          <>
            <TextField
              label="CLI Command"
              value={form.commandArgs}
              onChange={(value) => onChange({ commandArgs: value })}
              required
              placeholder="启动命令参数"
            />
            <TextField
              label="Model"
              value={form.defaultModel}
              onChange={(value) => onChange({ defaultModel: value })}
              required
              placeholder="模型标识符"
            />
          </>
        ) : (
          <>
            <SelectField
              label="认证信息"
              value={form.accountRef}
              options={[
                { value: '', label: loadingProfiles ? '加载中…' : '请选择认证方式' },
                ...accountOptions
                  .filter((profile) => {
                    // Gemini CLI doesn't support custom API endpoints — only show builtin
                    if (form.client === 'google' && !profile.builtin) return false;
                    return true;
                  })
                  .map((profile) => ({
                    value: profile.id,
                    label: profile.builtin ? `${profile.displayName}（内置）` : `${profile.displayName}（API Key）`,
                  })),
              ]}
              onChange={(value) => onChange({ accountRef: value, defaultModel: '', ocProviderName: '' })}
              disabled={loadingProfiles}
              required
            />
            {callHint ? (
              <div className="rounded-[10px] border border-dashed border-[#DCC9B8] bg-[#F7F3F0] px-3 py-2">
                <p className="whitespace-pre-wrap text-[11px] leading-4 text-[#8A776B]">{callHint}</p>
              </div>
            ) : null}
            <ComboField
              label="Model"
              ariaLabel="Model"
              value={form.defaultModel}
              onChange={(value) => onChange({ defaultModel: value })}
              suggestions={modelOptions}
              required
              placeholder={
                form.client === 'opencode'
                  ? '例如 openai/gpt-5.4 或 openrouter/google/gemini-3-flash-preview'
                  : '模型标识符，如 claude-sonnet-4-5'
              }
            />
            {form.client === 'opencode' && selectedProfile?.authType === 'api_key' ? (
              <ComboField
                label="Provider 名称"
                ariaLabel="OC Provider Name"
                value={form.ocProviderName}
                onChange={(value) => onChange({ ocProviderName: value })}
                suggestions={providerSuggestions}
                required
                placeholder="如 anthropic、openai、openrouter、maas"
              />
            ) : null}
            {form.client === 'opencode' &&
            form.defaultModel.trim() &&
            !form.defaultModel.includes('/') &&
            !form.ocProviderName.trim() ? (
              <div className="rounded-[10px] border border-dashed border-[#DCC9B8] bg-[#F7F3F0] px-3 py-2">
                <p className="text-[11px] leading-4 text-[#8A776B]">
                  建议使用 `providerId/modelId` 格式（例如 `openai/gpt-5.4`），部分 provider 需要前缀才能正确路由。
                </p>
              </div>
            ) : null}
          </>
        )}
      </div>
    </SectionCard>
  );
}

export function RoutingSection({
  form,
  hasError,
  onChange,
}: {
  cat?: CatData | null;
  form: HubCatEditorFormState;
  hasError?: boolean;
  onChange: (patch: FormPatch) => void;
}) {
  const aliases = currentAliasTags(form);
  return (
    <SectionCard title="别名与 @ 路由" tone={hasError ? 'error' : 'neutral'}>
      <TagEditor
        tags={aliases}
        onChange={(tags) => onChange({ mentionPatterns: joinTags(tags) })}
        addLabel="+ 添加"
        placeholder="@砚砚"
        emptyLabel="(至少添加 1 个别名，否则无法 @)"
        minCount={1}
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
