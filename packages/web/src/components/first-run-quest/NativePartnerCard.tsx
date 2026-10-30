import { nativeAcpProfileLabel, nativeAcpProfileMessage } from '../settings/members/native-acp-profile-status';
import { usesDefaultNativeIdentity } from '../settings/members/native-login-state';
import { NativeInstallHelp } from './NativeInstallHelp';
import { type NativePartner, nativePartnerSelectable, requiresDshDraftConfirmation } from './native-onboarding';
import { nativeModelLabel, usesDetectedRuntimeConfiguration } from './native-partner-config';

const chinese = (zh: string) => zh;
export function NativePartnerCard({
  partner,
  created,
  disabled = false,
  compact = false,
  patch,
}: {
  partner: NativePartner;
  created: boolean;
  disabled?: boolean;
  compact?: boolean;
  patch: (change: Partial<NativePartner>) => void;
}) {
  const { runtime, form } = partner;
  const locked = created && !(runtime.dshSetupRequired && partner.existingId);
  const available = runtime.installed && (runtime.clientId !== 'acp' || Boolean(runtime.acp));
  const selectable = nativePartnerSelectable(partner);
  const manualDsh = requiresDshDraftConfirmation(partner);
  const detectedConfiguration = usesDetectedRuntimeConfiguration(form, runtime);
  const defaultIdentity = usesDefaultNativeIdentity(form) && detectedConfiguration;
  const model = nativeModelLabel(
    runtime,
    form.defaultModel || (detectedConfiguration ? runtime.configuredModel : undefined),
  );
  const effort = form.cliEffort || (detectedConfiguration ? runtime.configuredEffort : undefined);
  const dshRoute = runtime.dshSetup;
  const profileLabel = manualDsh
    ? '已保留自定义设置 · 待确认连接'
    : dshRoute?.status === 'configured'
      ? '已检测可用配置'
      : nativeAcpProfileLabel(runtime.discoveryStatus, chinese);
  const profileMessage = manualDsh
    ? `模型：${form.defaultModel || '跟随工具'}${form.cliEffort ? ` · 强度：${form.cliEffort}` : ''}`
    : dshRoute?.status === 'configured'
      ? `连接：${dshRoute.provider} / ${dshRoute.model} · 复用 ${dshRoute.sourceProfile} 配置`
      : nativeAcpProfileMessage(runtime.discoveryStatus, chinese);
  return (
    <article
      className={`rounded-xl border p-4 ${partner.selected && selectable ? 'border-cafe-accent bg-cafe-surface' : 'border-[var(--console-border-soft)] bg-cafe-surface-canvas'}`}
    >
      <div className={`flex items-center ${compact ? 'gap-2' : 'gap-3'}`}>
        <input
          type="checkbox"
          aria-label={`加入 ${runtime.label} 伙伴`}
          checked={partner.selected && selectable}
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
            {locked
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
      {runtime.dshSetupRequired && (manualDsh || dshRoute?.status !== 'configured') && !locked && (
        <p role="status" className="mt-3 text-sm text-cafe-secondary">
          {manualDsh
            ? '此前的模型或思考强度已保留，请在“设置 → 成员与运行时”确认连接。'
            : '未找到可复用的 DSH 连接。请在成员配置中完成接入后重新检测。'}
        </p>
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
        <p className="mt-3 text-sm text-cafe-secondary">本机连接配置已就绪 · 实际连接待验证</p>
      )}
      {available && !defaultIdentity && (
        <p className="mt-3 text-sm text-cafe-secondary">
          {manualDsh
            ? '连接需要再次确认 · 原有设置已保留'
            : dshRoute?.status === 'configured' && detectedConfiguration
              ? '已检测到供应商与凭据配置 · 实际连接待验证'
              : '此连接的登录状态尚未检查 · 实际连接待验证'}
        </p>
      )}
      {available && runtime.clientId === 'opencode' && (
        <p className="mt-2 text-sm text-cafe-secondary">未选择项目时使用默认工作区；你也可以为对话选择项目目录。</p>
      )}
    </article>
  );
}
