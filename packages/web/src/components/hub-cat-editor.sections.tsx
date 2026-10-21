'use client';

import type { BuiltinCloudIdentityProtectedField, BuiltinCloudIdentityProtection } from '@cat-cafe/shared';
import { deploymentDefaults } from '@cat-cafe/shared';
import { useMemo, useRef } from 'react';
import type { CatData } from '@/hooks/useCatData';
import { useCoCreatorDisplay } from '@/hooks/useCoCreatorConfig';
import { AvatarImageWithFallback } from './AvatarImageWithFallback';
import { MemberAccountFollowing } from './accounts/MemberAccountFollowing';
import type { ProfileItem } from './hub-accounts.types';
import { usesAgyAcp, usesAgyNative } from './hub-cat-editor.agy';
import {
  autoSlug,
  CLIENT_OPTIONS,
  carrierOptionsForClient,
  defaultAcpCommandForClient,
  defaultAcpStartupArgsForClient,
  getAcpWarning,
  type HubCatEditorFormState,
  joinTags,
  normalizeMentionPattern,
  splitMentionPatterns,
  splitStrengthTags,
} from './hub-cat-editor.model';
import { AgyNativeFields } from './hub-cat-editor-agy';
import { MemberCarrierSelect } from './hub-cat-editor-carrier';
import { CatColorField } from './hub-cat-editor-color-field';
import { SectionCard, SelectField, TextField } from './hub-cat-editor-fields';
import { VoiceConfigSection } from './hub-cat-editor-voice';
import { TagEditor } from './hub-tag-editor';
import {
  useEditorLabel,
  useEditorText,
  useMemberEditorPresentation,
  useMemberFieldError,
  useMembersCopy,
} from './members/editor-presentation';
import { MemberChangedField, MemberChangeMark, useMemberChanged } from './members/MemberChangeMark';
import { MemberOperationFeedback } from './members/MemberOperationFeedback';

type FormPatch = Partial<HubCatEditorFormState>;

function acpDefaultsForClientSwitch(
  form: HubCatEditorFormState,
  nextClient: HubCatEditorFormState['clientId'],
): FormPatch {
  const currentCommand = form.acpCommand.trim();
  const currentStartupArgs = form.acpStartupArgs.trim();
  const currentDefaultCommand = defaultAcpCommandForClient(form.clientId);
  const currentDefaultStartupArgs = defaultAcpStartupArgsForClient(form.clientId);
  const patch: FormPatch = {};

  if (!currentCommand || currentCommand === currentDefaultCommand) {
    patch.acpCommand = defaultAcpCommandForClient(nextClient);
  }
  if (!currentStartupArgs || currentStartupArgs === currentDefaultStartupArgs) {
    patch.acpStartupArgs = defaultAcpStartupArgsForClient(nextClient);
  }

  return patch;
}

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
  hasDossier,
  onChange,
  onAvatarUpload,
  onRefAudioUpload,
}: {
  cat?: CatData | null;
  form: HubCatEditorFormState;
  hasError?: boolean;
  avatarUploading: boolean;
  /** F208 OQ-9: true when this cat has a structured dossier profile. */
  hasDossier?: boolean;
  onChange: (patch: FormPatch) => void;
  onAvatarUpload: (file: File) => Promise<void>;
  onRefAudioUpload: (file: File) => Promise<void>;
}) {
  const owner = useCoCreatorDisplay();
  const page = useMemberEditorPresentation();
  const t = useEditorText();
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
              const catId = autoSlug(value, form.catId);
              const useDefaultAlias =
                form.configurationSource === 'native_tool' &&
                (!form.mentionPatterns || form.mentionPatterns === '@' + form.catId);
              onChange({
                name: value,
                displayName: value,
                catId,
                ...(useDefaultAlias ? { mentionPatterns: '@' + catId } : {}),
              });
            }}
            required
            placeholder="成员显示名称，如 我的助手"
          />
          <input type="hidden" aria-label="Cat ID" value={form.catId} />
        </>
      ) : (
        <>
          {/* #968: Show catId (read-only) — above name so identity is first */}
          <label className="flex flex-col gap-1.5 text-cafe sm:flex-row sm:items-center sm:gap-[14px]">
            <span className="text-xs font-bold text-cafe-secondary sm:w-[150px] sm:shrink-0">
              {page ? t('成员 ID') : 'Cat ID'}
            </span>
            <div className="min-w-0 flex-1">
              <code className="block w-full rounded-lg border border-transparent bg-[var(--console-field-bg)] px-3 py-1.5 font-mono text-xs text-cafe-secondary select-all">
                {form.catId}
              </code>
            </div>
          </label>
          <TextField
            label="名称"
            ariaLabel="Name"
            value={form.name}
            onChange={(value) => onChange({ name: value, displayName: value })}
          />
        </>
      )}

      <TextField
        label="昵称"
        ariaLabel="Nickname"
        value={form.nickname}
        onChange={(value) => onChange({ nickname: value })}
        placeholder={`可选，${owner.nickname}给的昵称`}
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

      <MemberChangedField label="Avatar">
        <div className="flex items-center gap-3">
          <span className="text-xs font-bold text-cafe-secondary sm:w-[150px] sm:shrink-0">
            {page ? t('头像') : 'Avatar'}
          </span>
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
            <span>{t(avatarUploading ? '上传中…' : '点击上传')}</span>
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
        {(cat || !page) && <MemberOperationFeedback source="avatar" />}
      </MemberChangedField>

      {/* F056 KD-18 / AC-E4: single-hue input — all derivation from one primary color
       * (cat-persona-tokens.css OKLCH formulas). Secondary is deprecated; mirror
       * primary → secondary to keep the API payload backward-compatible. */}
      <MemberChangedField label="Background Color">
        <CatColorField
          value={form.colorPrimary}
          onChange={(hex) => onChange({ colorPrimary: hex, colorSecondary: hex })}
        />
      </MemberChangedField>

      {hasDossier && (
        <p className="rounded-lg bg-conn-purple-bg px-3 py-1.5 text-xs text-conn-purple-text">
          此猫已有结构化能力画像，擅长领域由画像驱动。此字段保留为社区兜底。
          <a href="/settings?s=profiles" className="ml-1 underline hover:no-underline">
            前往画像页 →
          </a>
        </p>
      )}
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

      <MemberChangedField label="Strengths">
        <div className="flex items-start gap-3">
          <span className="w-[140px] shrink-0 pt-1 text-sm font-medium text-cafe-secondary">
            {page ? t('技能标签') : 'Strengths'}
          </span>
          <div className="min-w-0 flex-1">
            <TagEditor
              tags={strengthTags}
              onChange={(tags) => onChange({ strengths: joinTags(tags) })}
              addLabel={t('+ 选择')}
              placeholder={t('输入标签，例如 security')}
              emptyLabel={t('(无)')}
            />
          </div>
          <input
            aria-label="Strengths"
            value={form.strengths}
            onChange={(event) => onChange({ strengths: event.target.value })}
            className="sr-only"
          />
        </div>
      </MemberChangedField>

      {!page && <VoiceConfigSection form={form} onChange={onChange} onRefAudioUpload={onRefAudioUpload} />}
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
  'zhipu',
  'glm',
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
  const displayLabel = useEditorLabel(label);
  const changed = useMemberChanged(ariaLabel ?? label);
  const invalid = useMemberFieldError(ariaLabel ?? label);
  const t = useEditorText();
  return (
    <label
      data-member-changed={changed || undefined}
      className="flex flex-col gap-1.5 text-cafe-secondary sm:flex-row sm:items-center sm:gap-3"
    >
      <span className="text-xs font-bold text-cafe-secondary sm:w-[150px] sm:shrink-0">
        {displayLabel}
        <MemberChangeMark label={ariaLabel ?? label} />
        {required && <span className="ml-0.5 text-cafe-accent">*</span>}
      </span>
      <div className="min-w-0 flex-1">
        <input
          aria-label={ariaLabel ?? label}
          aria-invalid={invalid || undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          list={listId}
          className="w-full rounded-[10px] border border-transparent bg-[var(--console-field-bg,var(--console-card-bg))] px-3.5 py-2 text-compact leading-5 text-cafe placeholder:text-[var(--cafe-text-muted)] outline-none transition focus:border-cafe-accent focus:ring-2 focus:ring-cafe-accent/30"
          placeholder={placeholder && t(placeholder)}
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
  cli: string;
  label: string;
  url: string;
  warning: string;
}

const PROTECTED_IDENTITY_FIELD_LABELS: Record<BuiltinCloudIdentityProtectedField, string> = {
  breedId: '所属家族',
  clientId: 'Client',
  defaultModel: '模型',
  provider: '云端 Provider',
  mcpSupport: 'Remote MCP',
  accountRef: '认证账号',
  cli: '本地 CLI',
  commandArgs: '启动参数',
  cliConfigArgs: 'CLI 配置',
  acp: 'ACP 传输',
  mentionPatterns: '主句柄 @gpt-pro',
};

export function ProtectedCloudIdentitySection({
  protection,
  restoring,
  onRestore,
}: {
  protection: BuiltinCloudIdentityProtection;
  restoring: boolean;
  onRestore: () => Promise<void> | void;
}) {
  const page = useMemberEditorPresentation();
  const t = useEditorText();
  const copy = useMembersCopy();
  const driftedLabels = protection.driftedFields.map((field) => t(PROTECTED_IDENTITY_FIELD_LABELS[field]));
  const drifted = protection.state === 'drifted';

  return (
    <SectionCard title="认证与模型" tone={drifted ? 'error' : 'neutral'} data-guide-id="member-editor.auth-config">
      <MemberOperationFeedback source="accounts" />
      <div className="space-y-3 rounded-xl bg-[var(--console-field-bg,var(--console-card-bg))] px-4 py-3">
        <div>
          <p className={`text-sm font-extrabold ${drifted ? 'text-conn-red-text' : 'text-cafe'}`}>
            {t(drifted ? '检测到云端身份配置异常' : '云端身份已保护')}
          </p>
          <p className="mt-1 text-xs leading-5 text-cafe-secondary">
            {page ? (
              copy.protectedCloudDescription
            ) : (
              <>
                @gpt-pro 是 {deploymentDefaults.brand.displayName} 的固定云端入口。它必须保持 ChatGPT Pro 与 Remote MCP
                身份，云端回复才能回到正确的
                Thread；因此这里不允许改所属家族、Client、模型、账号或本地运行方式。可以增加别名，主句柄 @gpt-pro
                固定。需要本地 Codex，请新建另一位成员。
              </>
            )}
          </p>
        </div>

        {drifted ? (
          <div className="space-y-2">
            <p className="text-xs leading-5 text-conn-red-text">
              {page ? (
                copy.protectedIdentityDrift(driftedLabels)
              ) : (
                <>
                  已偏离：{driftedLabels.join('、')}
                  。普通保存不会静默覆盖这些值；请明确恢复后再继续使用云端成员。
                </>
              )}
            </p>
            <button
              type="button"
              onClick={() => void onRestore()}
              disabled={restoring}
              className="h-8 rounded-[10px] bg-[var(--cafe-accent)] px-4 text-compact font-extrabold text-[var(--cafe-surface)] transition hover:bg-[var(--cafe-accent-hover)] disabled:opacity-50"
            >
              {t(restoring ? '恢复中…' : '恢复云端身份')}
            </button>
            <MemberOperationFeedback source="restore" />
          </div>
        ) : (
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-xs">
            <dt className="text-cafe-secondary">{t('接入方式')}</dt>
            <dd className="font-semibold text-cafe">{t('ChatGPT Pro 云端')}</dd>
            <dt className="text-cafe-secondary">{t('模型身份')}</dt>
            <dd className="font-semibold text-cafe">gpt-pro</dd>
            <dt className="text-cafe-secondary">{t('回程工具')}</dt>
            <dd className="font-semibold text-cafe">{t('Remote MCP 已开启')}</dd>
            <dt className="text-cafe-secondary">{t('本地运行时')}</dt>
            <dd className="font-semibold text-cafe">{t('未启用')}</dd>
          </dl>
        )}
      </div>
    </SectionCard>
  );
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
  return { cli: info.cli, label: `${info.cli} CLI 实际调用: `, url: fullUrl, warning };
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
  const page = useMemberEditorPresentation();
  const t = useEditorText();
  const accountOptions = availableProfiles;
  const copy = useMembersCopy();
  const selectedProfile = availableProfiles.find((p) => p.id === form.accountRef);
  const native = usesAgyNative(form);
  const officialAcp = usesAgyAcp(form);
  const callHint =
    native || officialAcp ? null : buildCallHint(form.clientId, selectedProfile, form.defaultModel, form.provider);
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
      <MemberOperationFeedback source="accounts" />
      <div className="space-y-2">
        <SelectField
          label="Client"
          value={form.clientId}
          options={
            form.clientId === 'antigravity'
              ? [...CLIENT_OPTIONS, { value: 'antigravity', label: 'Antigravity IDE（已退役）' }]
              : CLIENT_OPTIONS
          }
          onChange={(value) => {
            const nextClient = value as HubCatEditorFormState['clientId'];
            const nextCarrier = carrierOptionsForClient(nextClient)[0]?.value ?? 'cli';
            onChange({
              clientId: nextClient,
              provider: '',
              cliEffort: '',
              carrier: nextCarrier,
              agyNativeEnabled: nextClient === 'google',
              agyAcpEnabled: false,
              ...(nextClient === 'google'
                ? { agyProfileEnabled: true, agyProfileId: form.agyProfileId || form.catId }
                : {}),
              ...acpDefaultsForClientSwitch(form, nextClient),
            });
          }}
          required
        />

        {carrierOptionsForClient(form.clientId).length > 1 || form.clientId === 'acp' || form.clientId === 'google' ? (
          <MemberCarrierSelect form={form} onChange={onChange} ariaLabel={page ? 'Transport' : '接入方式'} />
        ) : null}

        {(() => {
          const acpWarn = getAcpWarning(form.clientId, form.carrier);
          return acpWarn ? <p className="text-xs text-amber-600 dark:text-amber-400">⚠️ {acpWarn}</p> : null;
        })()}

        {form.clientId === 'antigravity' ? (
          <p className="text-sm text-cafe-secondary">
            IDE 执行入口已退役。选择 Google / AGY Native 并保存隔离 Profile 后可继续使用；成员身份与历史消息保留。
          </p>
        ) : (
          <>
            <SelectField
              label="用哪个号"
              ariaLabel={page ? 'Account' : undefined}
              value={form.accountRef}
              options={[
                { value: '', label: loadingProfiles ? '加载中…' : '请选择认证方式' },
                ...accountOptions
                  .filter((profile) => {
                    if (native && profile.authType !== 'oauth') return false;
                    // Gemini CLI doesn't support custom API endpoints — only show builtin
                    // but allow api_key profiles with a third-party baseUrl (#470)
                    if (form.clientId === 'google' && profile.authType !== 'oauth' && !profile.baseUrl) return false;
                    return true;
                  })
                  .map((profile) => ({
                    value: profile.id,
                    disabled:
                      profile.clientId === 'openai' &&
                      profile.authType === 'oauth' &&
                      (profile.codex ? profile.codex.status !== 'ready' : profile.codexLoginStatus !== 'ready'),
                    label: page
                      ? copy.accountLabel(profile.displayName, profile.builtin ? 'builtin' : profile.authType)
                      : profile.builtin
                        ? `${profile.displayName}（内置）`
                        : profile.authType === 'oauth'
                          ? `${profile.displayName}（OAuth）`
                          : `${profile.displayName}（API Key）`,
                  })),
              ]}
              onChange={(value) =>
                onChange({
                  accountRef: value,
                  accountBindingMode: form.clientId === 'openai' ? 'override' : undefined,
                  defaultModel: '',
                  provider: '',
                })
              }
              disabled={loadingProfiles}
              required
            />
            {page && form.clientId === 'openai' && form.provider !== 'openai-chatgpt-pro' && (
              <MemberAccountFollowing
                accountRef={form.accountRef}
                accounts={availableProfiles}
                onFollow={(ref) => onChange({ accountRef: ref, accountBindingMode: 'follow' })}
              />
            )}
            <ComboField
              label="Model"
              ariaLabel="Model"
              value={form.defaultModel}
              onChange={(value) => onChange({ defaultModel: value })}
              suggestions={modelSuggestions}
              required={!page || selectedProfile?.authType === 'api_key'}
              placeholder={
                page
                  ? form.clientId === 'opencode'
                    ? 'openai/gpt-5.4 / openrouter/google/gemini-3-flash-preview'
                    : t('模型标识符')
                  : form.clientId === 'opencode'
                    ? '例如 openai/gpt-5.4 或 openrouter/google/gemini-3-flash-preview'
                    : '模型标识符，如 claude-sonnet-4-5'
              }
            />
            {native || officialAcp ? <AgyNativeFields form={form} onChange={onChange} /> : null}
            {modelNotListed ? (
              <div className="rounded-[10px] bg-[var(--console-field-bg,var(--console-card-bg))] px-3 py-2">
                <p className="text-xs leading-4 text-conn-amber-text">
                  {page
                    ? t('模型未列在这个账号中。保存时会保留你填写的模型。')
                    : '当前模型不在此认证信息的模型列表中；未修改 Model 时保存会保留原值，修改后会保存你输入的自定义值。'}
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
                  {page ? (
                    <>
                      {copy.cliActualCall(callHint.cli, callHint.url)}
                      {form.clientId === 'google' && (
                        <>
                          {'\n'}
                          {copy.cliGoogleWarning}
                        </>
                      )}
                    </>
                  ) : (
                    <>
                      {callHint.label}
                      <span className="font-semibold text-cafe">{callHint.url}</span>
                      {callHint.warning}
                    </>
                  )}
                </p>
              </div>
            ) : null}
            {form.carrier === 'acp' ? (
              <>
                <TextField
                  label="ACP Command"
                  value={form.acpCommand}
                  onChange={(value) => onChange({ acpCommand: value })}
                  required
                  placeholder={
                    officialAcp ? 'agy_acp_server.par' : defaultAcpCommandForClient(form.clientId) || 'agent-cli'
                  }
                />
                <TextField
                  label="ACP Startup Args"
                  value={form.acpStartupArgs}
                  onChange={(value) => onChange({ acpStartupArgs: value })}
                  required={!officialAcp}
                  placeholder={officialAcp ? '' : defaultAcpStartupArgsForClient(form.clientId) || '--acp'}
                />
                <p className="-mt-1 text-micro leading-4 text-cafe-muted">
                  {officialAcp ? (
                    t('官方 ACP 可留空；Command 填已安装程序的路径。')
                  ) : (
                    <>
                      空格分隔，如 <code className="text-cafe-secondary">acp --pure</code> 或{' '}
                      <code className="text-cafe-secondary">--acp --mode agent</code>。带空格的值用引号包裹。
                    </>
                  )}
                </p>
                <TextField
                  label="ACP Max Processes"
                  value={form.acpMaxLiveProcesses}
                  onChange={(value) => onChange({ acpMaxLiveProcesses: value })}
                  inputMode="numeric"
                  placeholder="3"
                />
                <TextField
                  label="ACP Idle TTL (min)"
                  value={form.acpIdleTtlMinutes}
                  onChange={(value) => onChange({ acpIdleTtlMinutes: value })}
                  inputMode="numeric"
                  placeholder="30"
                />
              </>
            ) : null}
          </>
        )}
        <SelectField
          label="MCP Support"
          value={form.mcpSupport ? 'true' : 'false'}
          options={[
            { value: 'true', label: '开启' },
            { value: 'false', label: '关闭' },
          ]}
          onChange={(value) => onChange({ mcpSupport: value === 'true' })}
        />
        <p className="-mt-1 text-micro leading-4 text-cafe-muted">
          {page
            ? t('发送消息、查记忆等协作工具。关闭后这个成员只能回复，不能使用这些工具协作。')
            : `控制该成员是否接收 ${deploymentDefaults.brand.name} MCP 工具（post_message、search_evidence 等）。关闭后该成员无法使用协作和记忆工具。`}
        </p>
      </div>
    </SectionCard>
  );
}

export function RoutingSection({
  form,
  hasError,
  reservedPatterns,
  fixedPatterns = [],
  onChange,
}: {
  cat?: CatData | null;
  form: HubCatEditorFormState;
  hasError?: boolean;
  /** Lowercase alias set already taken by other cats. */
  reservedPatterns?: ReadonlySet<string>;
  /** Product-owned handles that stay visible but cannot be removed. */
  fixedPatterns?: readonly string[];
  onChange: (patch: FormPatch) => void;
}) {
  const t = useEditorText();
  const invalid = useMemberFieldError('Aliases');
  const page = useMemberEditorPresentation();
  const copy = useMembersCopy();
  const aliases = currentAliasTags(form);
  const fixedPatternKeys = new Set(fixedPatterns.map((pattern) => pattern.toLowerCase()));
  const presentFixedPatterns = aliases.filter((pattern) => fixedPatternKeys.has(pattern.toLowerCase()));
  const updateAliases = (tags: string[]) => {
    const next = Array.from(new Set([...presentFixedPatterns, ...tags]));
    onChange({ mentionPatterns: joinTags(next) });
  };
  const validateAlias = useMemo(() => {
    if (!reservedPatterns?.size) return undefined;
    return (tag: string) => {
      if (reservedPatterns.has(tag.toLowerCase())) {
        return page ? copy.aliasTaken(tag) : `别名 "${tag}" 已被其他成员使用`;
      }
      return null;
    };
  }, [reservedPatterns, page, copy]);
  return (
    <SectionCard title="别名与 @ 路由" tone={hasError ? 'error' : 'neutral'} aria-invalid={invalid || undefined}>
      <MemberChangedField label="Aliases">
        <TagEditor
          tags={aliases}
          onChange={updateAliases}
          addLabel={t('+ 添加')}
          placeholder={page ? copy.砚砚(form.nickname || form.name || t('成员')) : '砚砚'}
          emptyLabel={t('(至少添加 1 个别名，否则无法 @)')}
          validate={validateAlias}
          lockedTags={presentFixedPatterns}
          minCount={presentFixedPatterns.length > 0 ? 0 : 1}
        />
        <textarea
          aria-label="Aliases"
          value={form.mentionPatterns}
          onChange={(event) => updateAliases(currentAliasTags({ ...form, mentionPatterns: event.target.value }))}
          placeholder="@codex, @缅因猫"
          className="sr-only"
        />
      </MemberChangedField>
    </SectionCard>
  );
}
