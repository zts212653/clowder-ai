'use client';
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { SelectField } from '../../hub-cat-editor-fields';

interface ConfigInfo {
  provider?: string;
  model?: string;
  providers: { id: string; models: { id: string; label: string }[]; credentialStatus?: 'configured' | 'missing' }[];
}
interface Inspection {
  profiles: string[];
  sourceProfile: string;
  revision: string;
  active: ConfigInfo;
  source: ConfigInfo;
}
const errors: Record<string, [string, string]> = {
  dsh_config_manual: [
    '配置包含自定义 header、未支持字段或内联认证，无法安全自动复制。请保留原配置，按指南在 DSH 手动配置 ACP。',
    'Custom headers, unsupported fields or inline authentication cannot be copied safely. Preserve the configuration and set up ACP manually using the DSH guide.',
  ],
  dsh_setup_changed: ['配置已变化，请重新读取后确认。', 'Configuration changed. Read it again before confirming.'],
  dsh_setup_profile_required: [
    '请选择已有的完整 DSH profile；先在 DSH 完成配置，再读取。',
    'Choose an existing complete DSH profile. Configure it in DSH first.',
  ],
  dsh_setup_custom_startup: [
    '此启动入口需要手动配置。请按 DSH 自定义 LLM 指南检查实际 HOME、profile 和 --patch。',
    'This launcher needs manual configuration. Check HOME, profile and --patch using the DSH guide.',
  ],
  dsh_inline_credential: [
    '配置包含内联认证。请先在 DSH 改用 apiKeyEnv 凭据引用，再重试。',
    'Inline authentication detected. Use a DSH apiKeyEnv reference before retrying.',
  ],
  dsh_config_expression: [
    '配置包含表达式，无法安全复用；请在 DSH 中手动配置 ACP。',
    'Expressions cannot be safely copied. Configure ACP in DSH manually.',
  ],
  dsh_setup_expired: [
    '验证凭据已过期，请重新读取和选择配置。',
    'The test receipt expired. Read and prepare the configuration again.',
  ],
  dsh_setup_credential_required: [
    '此路由尚无可读取的凭据。请在 DSH 的模型设置中配置接口凭据，再重新读取。',
    'This route has no readable credential. Configure it in DSH Models, then read again.',
  ],
  dsh_setup_credential_unavailable: [
    '无法读取 DSH 凭据状态，原文件已保留。',
    'Could not inspect DSH credentials. Existing files are preserved.',
  ],
};
export function DshProviderSetup({
  runtimeId,
  configurationKey,
  onPrepared,
  t,
  autoInspect = false,
}: {
  runtimeId: string;
  configurationKey?: string;
  onPrepared: (command: string, args: string[]) => void;
  t: (zh: string, en: string) => string;
  autoInspect?: boolean;
}) {
  const [inspection, setInspection] = useState<Inspection>();
  const [profiles, setProfiles] = useState(['acp', 'desktop', 'web']);
  const [sourceProfile, setSourceProfile] = useState('auto');
  const [provider, setProvider] = useState(''),
    [model, setModel] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [receipt, setReceipt] = useState(''),
    [tested, setTested] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    // Invalidate late responses when the runtime or its launch configuration changes.
    if (!runtimeId) return;
    setInspection(undefined);
    setReceipt('');
    setError('');
    setTested(false);
    setBusy(false);
    return () => {
      generation.current += 1;
    };
  }, [runtimeId, configurationKey]);
  async function request(action: string, body: Record<string, unknown>) {
    const response = await apiFetch(`/api/cats/dsh-setup/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) {
      if (Array.isArray(data.profiles) && data.profiles.length) setProfiles(data.profiles);
      throw Error(data.error || 'dsh_setup_unavailable');
    }
    return data;
  }
  async function run(action: 'inspect' | 'prepare' | 'test') {
    const active = generation.current;
    setBusy(true);
    setError('');
    setTested(false);
    try {
      if (action === 'inspect') {
        const data: Inspection = await request(action, { runtimeId, sourceProfile });
        if (active !== generation.current) return;
        setInspection(data);
        setProfiles(data.profiles);
        setSourceProfile(data.sourceProfile);
        setReceipt('');
        const usable = data.source.providers.filter((p) => p.credentialStatus !== 'missing' && p.models.length);
        const route = usable.find((p) => p.id === data.active.provider) ?? usable[0];
        setProvider(route?.id ?? '');
        setModel(route?.models.find((m) => m.id === data.active.model)?.id ?? route?.models[0]?.id ?? '');
      } else if (action === 'prepare' && inspection) {
        const data: { id: string; command: string; startupArgs: string[] } = await request(action, {
          runtimeId,
          sourceProfile,
          revision: inspection.revision,
          provider,
          model,
        });
        if (active !== generation.current) return;
        onPrepared(data.command, data.startupArgs);
        setReceipt(data.id);
      } else if (action === 'test') {
        await request(action, { id: receipt });
        if (active !== generation.current) return;
        setTested(true);
      }
    } catch (cause) {
      if (active !== generation.current) return;
      setError(cause instanceof Error ? cause.message : 'dsh_setup_unavailable');
    } finally {
      if (active === generation.current) setBusy(false);
    }
  }
  // biome-ignore lint/correctness/useExhaustiveDependencies: launch changes own auto reads; choosing another source remains an explicit read.
  useEffect(() => {
    if (autoInspect) void run('inspect');
  }, [autoInspect, runtimeId, configurationKey]);
  const routes = inspection?.source.providers ?? [];
  const usableRoute = routes.find((p) => p.id === provider && p.credentialStatus !== 'missing');
  const models = routes.find((p) => p.id === provider)?.models ?? [];
  return (
    <>
      <p className="text-sm text-cafe-secondary">
        {t(
          '手动接入或调整 DSH 连接时，请在下方确认供应商和模型，再保存成员。推荐伙伴可在一键创建时确认已检测到的连接。',
          'For manual setup or a connection change, confirm the provider and model below, then save the teammate. Recommended partners confirm the detected connection when you create them.',
        )}
      </p>
      <details
        open={autoInspect || undefined}
        className="rounded-xl border border-[var(--console-border-soft)] p-4 text-sm"
      >
        <summary className="cursor-pointer font-medium">{t('DSH 自定义 LLM', 'DSH custom LLM')}</summary>
        <p className="my-3 text-cafe-secondary">
          {t(
            '复用 DSH 已配置的接口，只为此成员生成专用配置。原生配置、认证和历史保留；无需配置官方供应商。',
            'Reuse a configured DSH provider for this teammate. Native configuration, credentials and history are preserved. No official provider is required.',
          )}
        </p>
        <a
          className="inline-flex min-h-10 items-center text-cafe-accent"
          href="https://github.com/zts212653/clowder-ai/blob/main/docs/ops/dsh-custom-llm-acp.md"
          target="_blank"
          rel="noreferrer"
        >
          {t('查看 DSH 配置指南', 'DSH configuration guide')}
        </a>
        <fieldset disabled={busy} className="min-w-0">
          <SelectField
            label={t('读取配置来源', 'Read configuration from')}
            value={sourceProfile}
            options={[
              { value: 'auto', label: t('自动选择可用配置', 'Automatically choose usable configuration') },
              ...profiles.map((value) => ({ value, label: value })),
            ]}
            onChange={(value) => {
              setSourceProfile(value);
              setInspection(undefined);
              setReceipt('');
              setError('');
              setTested(false);
            }}
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void run('inspect')}
            className="my-2 min-h-10 text-cafe-accent disabled:opacity-50"
          >
            {busy ? t('处理中…', 'Working…') : t('读取 DSH 配置', 'Read DSH configuration')}
          </button>
          {inspection && (
            <div className="space-y-3">
              <p>
                {t('当前 ACP 选择', 'Current ACP selection')}：{inspection.active.provider ?? '—'} /{' '}
                {inspection.active.model ?? '—'}
              </p>
              <p>
                {t('已读取配置来源', 'Configuration source')}：{inspection.sourceProfile}
              </p>
              {routes.length ? (
                <>
                  <SelectField
                    label={t('供应商路由', 'Provider route')}
                    value={provider}
                    options={routes.map((p) => ({
                      value: p.id,
                      label:
                        p.credentialStatus === 'missing' ? `${p.id} · ${t('缺少凭据', 'Credential missing')}` : p.id,
                      disabled: p.credentialStatus === 'missing',
                    }))}
                    onChange={(value) => {
                      setProvider(value);
                      setModel(routes.find((p) => p.id === value)?.models[0]?.id ?? '');
                      setReceipt('');
                      setTested(false);
                    }}
                  />
                  <SelectField
                    label={t('DSH 模型', 'DSH model')}
                    value={model}
                    options={models.map((m) => ({ value: m.id, label: m.label }))}
                    onChange={(value) => {
                      setModel(value);
                      setReceipt('');
                      setTested(false);
                    }}
                  />
                  {!models.length && (
                    <p className="text-cafe-secondary">
                      {t(
                        '此路由没有显式模型清单，请先在 DSH 配置模型。',
                        'Configure an explicit model list in DSH first.',
                      )}
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={busy || !model || !usableRoute}
                    onClick={() => void run('prepare')}
                    className="min-h-10 text-cafe-accent disabled:opacity-50"
                  >
                    {t('使用此配置', 'Use this configuration')}
                  </button>
                  {!usableRoute && (
                    <p role="status">
                      {t(
                        '没有已配置凭据的可用路由。请在 DSH 的“设置 → 模型”配置接口和凭据，然后点击“读取 DSH 配置”。不会使用未配置的官方接口创建伙伴。',
                        'No usable credential is configured. Configure the provider in DSH Settings → Models, then read again. An unconfigured official route will not be used to create this teammate.',
                      )}
                    </p>
                  )}
                </>
              ) : (
                <p className="text-cafe-secondary">
                  {t(
                    '此来源没有可复用的自定义接口。请选择 Desktop/Web 使用的 profile；如尚未配置，请先在 DSH 添加接口和凭据。',
                    'No reusable custom providers here. Choose your Desktop/Web profile, or configure a provider and credential in DSH first.',
                  )}
                </p>
              )}
            </div>
          )}
          {receipt && (
            <div role="status" className="mt-3 space-y-2 text-cafe-secondary">
              <p>
                {t(
                  '已加入草稿，请保存成员后使用。此配置只保留凭据引用，仍由原有 DSH 解析认证。',
                  'Added to the draft. Save the teammate to apply. Credentials remain resolved by DSH.',
                )}
              </p>
              <p>
                {t(
                  '可选验证会向模型发送一次请求，可能产生费用，并保留 DSH 测试会话。',
                  'Optional verification sends one model request, may incur a charge, and retains a DSH test session.',
                )}
              </p>
              <button
                type="button"
                disabled={busy}
                onClick={() => void run('test')}
                className="min-h-10 text-cafe-accent disabled:opacity-50"
              >
                {t('发送一次请求验证此配置', 'Send one request to test this configuration')}
              </button>
            </div>
          )}
          {tested && (
            <p role="status" className="mt-2 text-cafe-secondary">
              {t(
                '已收到模型文本回复。成员保存后的首轮和续聊仍请在聊天中确认。',
                'Model text received. Confirm first turn and continuation in chat after saving.',
              )}
            </p>
          )}
          {error && (
            <p role="alert" className="mt-3 text-conn-red-text">
              {errors[error]
                ? t(...errors[error])
                : t(
                    '无法完成 DSH 配置或验证。请检查实际启动入口、profile、凭据引用与 ACP 引导目录权限，再重新读取。原配置已保留。',
                    'DSH setup or verification failed. Check the launcher, profile, credential reference and ACP bootstrap permissions, then retry. Existing configuration is preserved.',
                  )}
            </p>
          )}
        </fieldset>
      </details>
    </>
  );
}
