'use client';
import { useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import { SelectField } from '../../hub-cat-editor-fields';

interface Inspection {
  revision: string;
  provider?: string;
  model?: string;
  providers: {
    id: string;
    credential: 'configured' | 'missing' | 'native_auth';
    models: { id: string; label: string }[];
  }[];
}
export interface PreparedDshConnection {
  id: string;
  command: string;
  startupArgs: string[];
  env: Record<string, string>;
  provider: string;
  model: string;
}
const errors: Record<string, [string, string]> = {
  dsh_setup_changed: ['配置已变化，请重新读取后确认。', 'Configuration changed. Read it again.'],
  dsh_config_manual: [
    '此配置暂不支持自动接入，请先在 Desktop 使用凭据引用和受支持的配置。',
    'Use supported settings and credential references in Desktop before retrying.',
  ],
  dsh_inline_credential: [
    '请先在 Desktop 改用凭据引用，再重试。',
    'Use a credential reference in Desktop, then retry.',
  ],
  dsh_config_expression: [
    '此配置包含表达式，暂不支持自动接入。',
    'This configuration uses expressions and cannot be reused automatically.',
  ],
  dsh_setup_profile_required: ['请先在 DSH Desktop 完成模型配置。', 'Configure a model in DSH Desktop first.'],
  dsh_setup_custom_startup: [
    '未找到受支持的 DSH Desktop 安装。',
    'A supported DSH Desktop installation was not found.',
  ],
  dsh_setup_desktop_ambiguous: [
    '发现多套 Desktop，请确认要使用的安装位置。',
    'Several Desktop installations were found. Confirm which installation to use.',
  ],
  dsh_setup_credential_missing: [
    '此路线未配置认证，请先在 Desktop 配置后重试。',
    'Configure authentication for this route in Desktop first.',
  ],
  dsh_setup_credential_invalid: [
    'Desktop 凭据文件无法读取，请先在 Desktop 检查认证。',
    'The Desktop credential file could not be read. Check authentication in Desktop.',
  ],
  dsh_setup_auth_refresh_required: [
    '请先在 DSH Desktop 更新登录认证，再重新验证。',
    'Update your authentication in DSH Desktop, then verify again.',
  ],
  dsh_setup_start_failed: [
    'DSH Desktop 未能启动接入，请检查安装后重试。',
    'Desktop could not start the connection. Check the installation and retry.',
  ],
  dsh_setup_test_failed: [
    '模型请求未通过，请检查接口、模型、额度和网络后重试。',
    'The model request failed. Check the endpoint, model, quota and network.',
  ],
};

export function DshProviderSetup({
  runtimeId,
  configurationKey,
  verificationKey,
  selectedModel,
  effort,
  onPrepared,
  t,
}: {
  runtimeId: string;
  configurationKey?: string;
  verificationKey?: string;
  selectedModel?: string;
  effort?: string;
  onPrepared: (value: PreparedDshConnection) => string | void;
  t: (zh: string, en: string) => string;
}) {
  const [inspection, setInspection] = useState<Inspection>();
  const [provider, setProvider] = useState(''),
    [model, setModel] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [testedKey, setTestedKey] = useState<string>();
  const generation = useRef(0);
  const key = verificationKey ?? JSON.stringify([runtimeId, configurationKey, selectedModel, effort]);
  const currentKey = useRef(key);
  currentKey.current = key;
  useEffect(() => {
    setInspection(undefined);
    setError('');
    setTestedKey(undefined);
    setBusy(false);
    return () => {
      generation.current += 1;
    };
  }, [runtimeId, configurationKey]);
  async function request<T>(action: string, body: Record<string, unknown>): Promise<T> {
    const response = await apiFetch(`/api/cats/dsh-setup/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'dsh_setup_unavailable');
    return data;
  }
  async function run(action: 'inspect' | 'connect') {
    const active = generation.current,
      checked = currentKey.current;
    setBusy(true);
    setError('');
    setTestedKey(undefined);
    try {
      if (action === 'inspect') {
        const data = await request<Inspection>('inspect', { runtimeId });
        if (active !== generation.current) return;
        const explicit = data.providers
          .flatMap((route) =>
            route.credential === 'missing'
              ? []
              : route.models.map((model) => ({ provider: route.id, model: model.id })),
          )
          .find((selection) => JSON.stringify([selection.provider, selection.model]) === selectedModel);
        setInspection(data);
        setProvider(explicit?.provider ?? data.provider ?? '');
        setModel(explicit?.model ?? data.model ?? '');
      } else if (inspection) {
        const value = await request<PreparedDshConnection>('prepare', {
          runtimeId,
          revision: inspection.revision,
          provider,
          model,
        });
        if (active !== generation.current || checked !== currentKey.current) return;
        await request('test', {
          id: value.id,
          model: JSON.stringify([provider, model]),
          ...(effort ? { effort } : {}),
        });
        if (active !== generation.current || checked !== currentKey.current) return;
        const appliedKey = onPrepared(value);
        setTestedKey(appliedKey ?? checked);
      }
    } catch (cause) {
      if (active === generation.current) setError(cause instanceof Error ? cause.message : 'dsh_setup_unavailable');
    } finally {
      if (active === generation.current) setBusy(false);
    }
  }
  const routes = inspection?.providers ?? [];
  const route = routes.find((item) => item.id === provider);
  return (
    <div className="space-y-3 text-sm">
      <p className="text-cafe-secondary">
        {t(
          '复用 DSH Desktop 的模型与认证。官方认证已配置时默认官方；缺失时使用已有自定义路线。原配置与历史保留。',
          'Reuse Desktop models and authentication. Prefer configured official authentication; otherwise use an existing custom route. Native configuration and history are preserved.',
        )}
      </p>
      <fieldset disabled={busy} className="min-w-0 space-y-3">
        <button
          type="button"
          onClick={() => void run('inspect')}
          className="min-h-10 text-cafe-accent disabled:opacity-50"
        >
          {busy ? t('处理中…', 'Working…') : t('读取 Desktop 配置', 'Read Desktop configuration')}
        </button>
        {inspection && (
          <>
            <SelectField
              label={t('供应商路线', 'Provider route')}
              value={provider}
              options={[
                { value: '', label: t('选择路线', 'Choose a route') },
                ...routes.map((item) => ({
                  value: item.id,
                  label:
                    item.credential === 'missing'
                      ? `${item.id} · ${t('未配置认证', 'Authentication missing')}`
                      : item.id,
                  disabled: item.credential === 'missing',
                })),
              ]}
              onChange={(value) => {
                setProvider(value);
                setModel(routes.find((item) => item.id === value)?.models[0]?.id ?? '');
                setTestedKey(undefined);
              }}
            />
            <SelectField
              label={t('DSH 模型', 'DSH model')}
              value={model}
              options={(route?.models ?? []).map((item) => ({ value: item.id, label: item.label }))}
              onChange={(value) => {
                setModel(value);
                setTestedKey(undefined);
              }}
            />
            {!route?.models.length && (
              <p className="text-cafe-secondary">
                {t(
                  '请在 Desktop 配置可用路线及模型后重新读取。',
                  'Configure a usable route and model in Desktop, then read again.',
                )}
              </p>
            )}
            <p className="text-cafe-secondary">
              {t(
                '验证会发送一次模型请求，可能产生费用。通过后加入成员草稿。',
                'Verification sends one model request and may incur a charge. Success adds the connection to your member draft.',
              )}
            </p>
            <button
              type="button"
              disabled={!model || !provider || route?.credential === 'missing'}
              onClick={() => void run('connect')}
              className="min-h-10 text-cafe-accent disabled:opacity-50"
            >
              {t('验证并使用此模型', 'Verify and use this model')}
            </button>
          </>
        )}
      </fieldset>
      {testedKey === key && (
        <p role="status" className="text-cafe-secondary">
          {t(
            '此配置已收到模型回复，请保存成员。修改模型、思考强度或启动配置后需重新验证。',
            'The model replied. Save the teammate. Verify again after changing the model, effort or launch settings.',
          )}
        </p>
      )}
      {error && (
        <p role="alert" className="text-conn-red-text">
          {errors[error]
            ? t(...errors[error])
            : t(
                '无法完成 Desktop 接入，请检查 Desktop 配置后重新读取。原配置已保留。',
                'Desktop connection failed. Check Desktop settings and read again. Existing configuration is preserved.',
              )}
        </p>
      )}
    </div>
  );
}
