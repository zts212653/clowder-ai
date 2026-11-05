import { useState } from 'react';
import { MemberRuntimeFields } from '../settings/members/MemberRuntimeFields';
import { nativeAcpProfileLabel, nativeAcpProfileMessage } from '../settings/members/native-acp-profile-status';
import { usesDefaultNativeIdentity } from '../settings/members/native-login-state';
import { NativeInstallHelp } from './NativeInstallHelp';
import { type NativePartner, nativeRuntimeSelectable } from './native-onboarding';
import { nativeModelLabel, usesDetectedRuntimeConfiguration } from './native-partner-config';

const chinese = (zh: string) => zh;
export function NativePartnerCard({
  partner,
  created,
  disabled = false,
  compact = false,
  patch,
  onValidityChange,
}: {
  partner: NativePartner;
  created: boolean;
  disabled?: boolean;
  compact?: boolean;
  patch: (change: Partial<NativePartner>) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { runtime, form } = partner;
  const available = runtime.installed && (runtime.clientId !== 'acp' || Boolean(runtime.acp));
  const selectable = nativeRuntimeSelectable(runtime, form);
  const detectedConfiguration = usesDetectedRuntimeConfiguration(form, runtime);
  const defaultIdentity = usesDefaultNativeIdentity(form) && detectedConfiguration;
  const model = nativeModelLabel(
    runtime,
    form.defaultModel || (detectedConfiguration ? runtime.configuredModel : undefined),
  );
  const effort = form.cliEffort || (detectedConfiguration ? runtime.configuredEffort : undefined);
  const profileLabel = nativeAcpProfileLabel(runtime.discoveryStatus, chinese);
  const profileMessage = nativeAcpProfileMessage(runtime.discoveryStatus, chinese);
  return (
    <article
      className={`rounded-xl border p-4 ${partner.selected ? 'border-cafe-accent bg-cafe-surface' : 'border-[var(--console-border-soft)] bg-cafe-surface-canvas'}`}
    >
      <div className={`flex items-center ${compact ? 'gap-2' : 'gap-3'}`}>
        <input
          type="checkbox"
          aria-label={`加入 ${runtime.label} 伙伴`}
          checked={partner.selected}
          disabled={!selectable || disabled}
          onChange={(e) => patch({ selected: e.target.checked })}
          className="h-5 w-5 shrink-0 accent-[var(--color-cafe-accent)]"
        />
        <div
          className={`flex shrink-0 items-center justify-center overflow-hidden rounded-full ${compact ? 'h-9 w-9' : 'h-12 w-12'}`}
          style={{ backgroundColor: form.colorSecondary }}
        >
          {form.avatar ? (
            <img src={form.avatar} alt="" className="h-full w-full object-cover" />
          ) : (
            <span>{runtime.label[0]}</span>
          )}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="font-semibold">
            {form.displayName}
            {form.nickname && ` · ${form.nickname}`}
          </h3>
          <p className="mt-1 text-sm text-cafe-secondary">
            {runtime.label} ·{' '}
            {created
              ? '已添加'
              : profileLabel
                ? profileLabel
                : available && defaultIdentity && runtime.readiness?.status === 'login_required'
                  ? '已安装 · 登录校验未通过'
                  : available
                    ? '已安装'
                    : runtime.discoveryStatus === 'adapter_missing'
                      ? '已安装 · 待接入适配器'
                      : '未检测到'}
          </p>
        </div>
        {runtime.installed && (
          <button
            type="button"
            disabled={created || disabled}
            onClick={() => setExpanded(!expanded)}
            aria-expanded={expanded}
            className="min-h-10 shrink-0 text-sm text-cafe-accent"
          >
            {expanded ? '收起' : '调整'}
          </button>
        )}
      </div>
      {form.roleDescription && (
        <p className={`${compact ? '' : 'ml-8'} mt-3 text-sm text-cafe-secondary`}>{form.roleDescription}</p>
      )}
      {form.personality && (
        <p className={`${compact ? '' : 'ml-8'} mt-2 text-sm text-cafe-muted`}>性格：{form.personality}</p>
      )}
      <p className={`${compact ? '' : 'ml-8'} mt-3 text-sm text-cafe-muted`}>
        {profileMessage ||
          (available
            ? `模型：${model || '由工具决定（未读取）'}${form.defaultModel ? ' · 角色自选' : runtime.modelSource === 'tool_recent' && detectedConfiguration ? ' · 跟随最近选择' : ' · 跟随工具'}${effort ? ` · 强度：${effort}` : ''}`
            : runtime.discoveryStatus === 'adapter_missing'
              ? '已发现 Pi。需要 ACP 适配器后才能通过此入口接入。'
              : runtime.label === 'DSH'
                ? '安装 DSH 后重新检测；首次连接时由 DSH 准备 ACP。'
                : `安装并登录 ${runtime.label} 后，重新检测即可加入。`)}
      </p>
      {!available && <NativeInstallHelp runtime={runtime} />}
      {partner.missingExisting && !created && (
        <p className="mt-3 text-sm text-cafe-secondary">原伙伴已不在当前名单中。确认创建后，会按保留的配置重新添加。</p>
      )}
      {partner.recoverable && !created && (
        <div className="mt-3 text-sm text-cafe-secondary">
          <p>这个旧草稿的 ID 已存在，尚无可验证的创建回执。可以明确复用现有伙伴。</p>
          <button
            type="button"
            disabled={disabled}
            className="min-h-10 text-cafe-accent"
            onClick={() =>
              patch({
                existingId: partner.recoverable?.id,
                form: partner.recoverable?.form ?? form,
                recoverable: undefined,
              })
            }
          >
            复用现有伙伴 {partner.recoverable.id}
          </button>
        </div>
      )}
      {defaultIdentity && runtime.readiness?.status === 'login_required' && (
        <div role="status" className="mt-3 rounded-lg bg-conn-amber-bg p-3 text-sm text-conn-amber-text">
          <p className="font-medium">{runtime.label} 尚未登录</p>
          <p className="mt-1">
            {runtime.clientId === 'openai'
              ? 'Codex 登录校验未通过；新增伙伴前需要先登录。'
              : '新增伙伴前需要先登录；其他连接请通过手动入口创建。'}
            在此运行环境执行 <code>{runtime.readiness.loginCommand}</code>
            ，然后重新检测。
          </p>
        </div>
      )}
      {available && defaultIdentity && runtime.readiness?.status === 'configured' && (
        <p className="mt-3 text-sm text-cafe-secondary">已检测登录 · 实际连接待验证</p>
      )}
      {available && !defaultIdentity && (
        <p className="mt-3 text-sm text-cafe-secondary">此连接的登录状态尚未检查 · 实际连接待验证</p>
      )}
      {available && runtime.clientId === 'opencode' && (
        <p className="mt-2 text-sm text-cafe-secondary">未选择项目时使用默认工作区；你也可以为对话选择项目目录。</p>
      )}
      {expanded && (
        <fieldset
          disabled={disabled || created}
          className="mt-4 space-y-4 border-t border-[var(--console-border-soft)] pt-4"
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-sm">
              名字
              <input
                value={form.displayName}
                onChange={(e) => patch({ form: { ...form, name: e.target.value, displayName: e.target.value } })}
                className="mt-2 min-h-10 w-full rounded-lg border border-[var(--console-border-soft)] bg-cafe-surface-canvas px-3"
              />
            </label>
            <label className="text-sm">
              昵称
              <input
                value={form.nickname}
                onChange={(e) => patch({ form: { ...form, nickname: e.target.value } })}
                className="mt-2 min-h-10 w-full rounded-lg border border-[var(--console-border-soft)] bg-cafe-surface-canvas px-3"
              />
            </label>
          </div>
          <MemberRuntimeFields
            nativeSetup
            form={form}
            accounts={[]}
            patch={(change) => patch({ form: { ...form, ...change } })}
            t={chinese}
            accountHref="/settings?s=members"
            editing={false}
            onValidityChange={onValidityChange}
          />
        </fieldset>
      )}
    </article>
  );
}
