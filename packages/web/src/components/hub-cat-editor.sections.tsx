'use client';

import { useMemo, useRef } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { AvatarImageWithFallback } from './AvatarImageWithFallback';
import type { ProfileItem } from './hub-accounts.types';
import {
  autoSlug,
  CLIENT_OPTIONS,
  type HubCatEditorFormState,
  joinTags,
  normalizeMentionPattern,
  splitMentionPatterns,
  splitStrengthTags,
} from './hub-cat-editor.model';
import { CatColorField } from './hub-cat-editor-color-field';
import { SectionCard, SelectField, TextField } from './hub-cat-editor-fields';
import { VoiceConfigSection } from './hub-cat-editor-voice';
import { TagEditor } from './hub-tag-editor';

type FormPatch = Partial<HubCatEditorFormState>;

function safeAvatarSrc(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('/uploads/') || trimmed.startsWith('/avatars/')) return trimmed;
  return null;
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
  onRefAudioUpload,
}: {
  cat?: CatData | null;
  form: HubCatEditorFormState;
  hasError?: boolean;
  avatarUploading: boolean;
  onChange: (patch: FormPatch) => void;
  onAvatarUpload: (file: File) => Promise<void>;
  onRefAudioUpload: (file: File) => Promise<void>;
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
        label="显示后缀"
        ariaLabel="Variant Label"
        value={form.variantLabel}
        onChange={(value) => onChange({ variantLabel: value })}
        placeholder="如 GPT-5.5 / Opus 4.7"
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
        <span className="text-xs font-bold text-cafe-secondary sm:w-[150px] sm:shrink-0">Avatar</span>
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-2 rounded-[10px] bg-[var(--console-field-bg,var(--console-card-bg))] px-3 py-1.5 text-compact text-cafe-secondary transition hover:opacity-80"
        >
          <div className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-cafe-surface-canvas text-micro text-cafe-secondary">
            {avatarSrc ? (
              <AvatarImageWithFallback src={avatarSrc} alt="Avatar preview" className="h-full w-full object-cover" />
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

      {/* F056 KD-18 / AC-E4: single-hue input — all derivation from one primary color
       * (cat-persona-tokens.css OKLCH formulas). Secondary is deprecated; mirror
       * primary → secondary to keep the API payload backward-compatible. */}
      <CatColorField
        value={form.colorPrimary}
        onChange={(hex) => onChange({ colorPrimary: hex, colorSecondary: hex })}
      />

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
        <span className="w-[140px] shrink-0 pt-1 text-sm font-medium text-cafe-secondary">Strengths</span>
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

      <VoiceConfigSection form={form} onChange={onChange} onRefAudioUpload={onRefAudioUpload} />
    </SectionCard>
  );
}

/** Well-known OpenCode provider names (always shown as suggestions). */
export const KNOWN_OC_PROVIDERS = [
  'anthropic',
  'openai',
  'openai-responses',
  'openrouter',
  'google',
  'azure',
  'deepseek',
];

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
    <label className="flex flex-col gap-1.5 text-cafe-secondary sm:flex-row sm:items-center sm:gap-3">
      <span className="text-xs font-bold text-cafe-secondary sm:w-[150px] sm:shrink-0">
        {label}
        {required && <span className="ml-0.5 text-cafe-accent">*</span>}
      </span>
      <div className="min-w-0 flex-1">
        <input
          aria-label={ariaLabel ?? label}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          list={listId}
          className="w-full rounded-[10px] border border-transparent bg-[var(--console-field-bg,var(--console-card-bg))] px-3.5 py-2 text-compact leading-5 text-cafe placeholder:text-[var(--cafe-text-muted)] outline-none transition focus:border-cafe-accent focus:ring-2 focus:ring-cafe-accent/30"
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

// Derive the opencode endpoint suffix from provider name (sole authority).
// Account-level protocol is no longer used — mirrors backend deriveOpenCodeApiType.
export function resolveOpenCodeEndpoint(providerName: string): string {
  const normalized = providerName.toLowerCase();
  if (normalized === 'openai-responses') return '/v1/responses';
  if (normalized === 'anthropic') return '/v1/messages';
  if (normalized === 'google') return '/models/{model}:generateContent';
  return '/v1/chat/completions';
}

interface CallHint {
  label: string;
  url: string;
  warning: string;
}

// Generate a hint showing what API endpoint the CLI will actually call.
// Exported for testing (#886 regression coverage).
export function buildCallHint(
  client: string,
  profile: ProfileItem | undefined,
  model: string,
  providerName: string,
): CallHint | null {
  if (!profile || profile.authType === 'oauth' || !profile.baseUrl) return null;
  const base = profile.baseUrl.replace(/\/+$/, '');
  // #886: detect ANY api-version suffix (/v1, /v2, …), not just /v1.
  const versionMatch = base.match(/\/(v\d+)$/i);
  const baseWithoutVersion = versionMatch ? base.slice(0, -versionMatch[0].length) : base;

  // For opencode, derive endpoint dynamically from provider name (sole authority)
  const ocPath = client === 'opencode' ? resolveOpenCodeEndpoint(providerName) : undefined;

  const cliEndpoints: Record<string, { cli: string; pathSuffix: string }> = {
    anthropic: { cli: 'claude', pathSuffix: '/v1/messages' },
    opencode: { cli: 'opencode', pathSuffix: ocPath ?? '/v1/chat/completions' },
    openai: { cli: 'codex', pathSuffix: '/v1/responses' },
    google: { cli: 'gemini', pathSuffix: `/models/${model || '...'}:generateContent` },
    dare: { cli: 'dare', pathSuffix: '/v1/chat/completions' },
  };
  const info = cliEndpoints[client];
  if (!info) return null;

  // Match display URL to actual CLI runtime behavior:
  // - base has /v1 + suffix has /v1 → strip /v1 from base to avoid /v1/v1.
  // - only opencode uses provider base URLs as exact endpoint roots; for /vN
  //   bases it calls /vN/<endpoint>, not /vN/v1/<endpoint> (#886).
  //   Other CLIs keep their own /v1 suffix semantics.
  let effectiveBase = base;
  let effectiveSuffix = info.pathSuffix;
  if (info.pathSuffix.startsWith('/v1') && versionMatch) {
    if (versionMatch[1].toLowerCase() === 'v1') {
      effectiveBase = baseWithoutVersion;
    } else if (client === 'opencode') {
      effectiveSuffix = info.pathSuffix.slice(3); // strip "/v1" prefix
    }
  }
  const fullUrl = `${effectiveBase}${effectiveSuffix}`;
  let warning = '';
  if (client === 'google') {
    warning = '\n注意: Google 官方 endpoint 仍要求 builtin OAuth；第三方 gateway 会走这里展示的 baseUrl。';
  }
  return { label: `${info.cli} CLI 实际调用: `, url: fullUrl, warning };
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
  const callHint = buildCallHint(form.clientId, selectedProfile, form.defaultModel, form.provider);
  const selectedModel = form.defaultModel.trim();
  const modelNotListed = selectedModel.length > 0 && modelOptions.length > 0 && !modelOptions.includes(selectedModel);
  const modelSuggestions = useMemo(
    () => (modelNotListed ? [selectedModel, ...modelOptions] : modelOptions),
    [modelNotListed, modelOptions, selectedModel],
  );
  const providerSuggestions = useMemo(
    () => buildProviderSuggestions(selectedProfile?.models ?? []),
    [selectedProfile?.models],
  );

  return (
    <SectionCard title="认证与模型" tone={hasError ? 'error' : 'neutral'} data-guide-id="member-editor.auth-config">
      <div className="space-y-2">
        <SelectField
          label="Client"
          value={form.clientId}
          options={CLIENT_OPTIONS}
          onChange={(value) =>
            onChange({ clientId: value as HubCatEditorFormState['clientId'], provider: '', cliEffort: '' })
          }
          required
        />

        {form.clientId === 'antigravity' ? (
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
                    if (form.clientId === 'google' && profile.authType !== 'oauth') return false;
                    return true;
                  })
                  .map((profile) => ({
                    value: profile.id,
                    label: profile.builtin
                      ? `${profile.displayName}（内置）`
                      : profile.authType === 'oauth'
                        ? `${profile.displayName}（OAuth）`
                        : `${profile.displayName}（API Key）`,
                  })),
              ]}
              onChange={(value) => onChange({ accountRef: value, defaultModel: '', provider: '' })}
              disabled={loadingProfiles}
              required
            />
            <ComboField
              label="Model"
              ariaLabel="Model"
              value={form.defaultModel}
              onChange={(value) => onChange({ defaultModel: value })}
              suggestions={modelSuggestions}
              required
              placeholder={
                form.clientId === 'opencode'
                  ? '例如 openai/gpt-5.4 或 openrouter/google/gemini-3-flash-preview'
                  : '模型标识符，如 claude-sonnet-4-5'
              }
            />
            {modelNotListed ? (
              <div className="rounded-[10px] bg-[var(--console-field-bg,var(--console-card-bg))] px-3 py-2">
                <p className="text-xs leading-4 text-conn-amber-text">
                  当前模型不在此认证信息的模型列表中；未修改 Model 时保存会保留原值，修改后会保存你输入的自定义值。
                </p>
              </div>
            ) : null}
            {form.clientId === 'opencode' && selectedProfile?.authType === 'api_key' ? (
              <>
                <ComboField
                  label="Provider 名称"
                  ariaLabel="OC Provider Name"
                  value={form.provider}
                  onChange={(value) => onChange({ provider: value })}
                  suggestions={providerSuggestions}
                  required
                  placeholder="如 anthropic、openai、openai-responses、openrouter、maas"
                />
                <p className="text-xs leading-4 text-cafe-secondary">
                  OpenCode 根据 Provider 名称决定实际的 API 协议类型（如 openai → Chat Completions, anthropic →
                  Messages, openai-responses → Responses）
                </p>
              </>
            ) : null}
            {form.clientId === 'opencode' &&
            form.defaultModel.trim() &&
            !form.defaultModel.includes('/') &&
            !form.provider.trim() ? (
              <div className="rounded-[10px] bg-[var(--console-field-bg,var(--console-card-bg))] px-3 py-2">
                <p className="text-xs leading-4 text-cafe-secondary">
                  建议使用 `providerId/modelId` 格式（例如 `openai/gpt-5.4`），部分 provider 需要前缀才能正确路由。
                </p>
              </div>
            ) : null}
            {callHint ? (
              <div className="rounded-[10px] bg-[var(--console-field-bg,var(--console-card-bg))] px-3 py-2">
                <p className="whitespace-pre-wrap text-xs leading-4 text-cafe-secondary">
                  {callHint.label}
                  <span className="font-semibold text-cafe">{callHint.url}</span>
                  {callHint.warning}
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
  reservedPatterns,
  onChange,
}: {
  cat?: CatData | null;
  form: HubCatEditorFormState;
  hasError?: boolean;
  /** Lowercase alias set already taken by other cats. */
  reservedPatterns?: ReadonlySet<string>;
  onChange: (patch: FormPatch) => void;
}) {
  const aliases = currentAliasTags(form);
  const validateAlias = useMemo(() => {
    if (!reservedPatterns?.size) return undefined;
    return (tag: string) => {
      if (reservedPatterns.has(tag.toLowerCase())) {
        return `别名 "${tag}" 已被其他成员使用`;
      }
      return null;
    };
  }, [reservedPatterns]);
  return (
    <SectionCard title="别名与 @ 路由" tone={hasError ? 'error' : 'neutral'}>
      <TagEditor
        tags={aliases}
        onChange={(tags) => onChange({ mentionPatterns: joinTags(tags) })}
        addLabel="+ 添加"
        placeholder="砚砚"
        emptyLabel="(至少添加 1 个别名，否则无法 @)"
        validate={validateAlias}
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
