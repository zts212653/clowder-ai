'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { apiFetch } from '@/utils/api-client';
import type { ProfileItem } from '../../hub-accounts.types';
import { serializeCommandArgs } from '../../hub-cat-editor.acp';
import {
  builtinAccountIdForClient,
  filterAccounts,
  type HubCatEditorFormState,
  splitCommandArgs,
} from '../../hub-cat-editor.model';
import { SelectField } from '../../hub-cat-editor-fields';
import { MemberChoicePicker } from './MemberChoicePicker';
import { useRuntimeCatalog } from './useRuntimeCatalog';

interface RuntimeChoice {
  id: string;
  label: string;
  clientId: HubCatEditorFormState['clientId'];
  installed: boolean;
  models: string[];
  configuredModel?: string;
  configuredEffort?: string;
  acp?: { command: string; startupArgs: string[]; transport?: 'stdio' | 'httpstream' };
}
export type MemberText = (zh: string, en: string) => string;
export function MemberRuntimeFields({
  form,
  accounts,
  patch,
  t,
  accountHref,
  editing,
  onValidityChange,
}: {
  form: HubCatEditorFormState;
  accounts: ProfileItem[];
  patch: (value: Partial<HubCatEditorFormState>) => void;
  t: MemberText;
  accountHref: string;
  editing: boolean;
  onValidityChange?: (valid: boolean) => void;
}) {
  const [runtimes, setRuntimes] = useState<RuntimeChoice[]>([]),
    [error, setError] = useState(false),
    [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0);
  const [pendingTool, setPendingTool] = useState<RuntimeChoice | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    apiFetch('/api/cats/native-runtimes', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw Error('discovery');
        return (await response.json()) as { runtimes: RuntimeChoice[] };
      })
      .then((data) => {
        if (!controller.signal.aborted) setRuntimes(data.runtimes);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refresh]);
  const selected = runtimes.find(
    (item) =>
      item.clientId === form.clientId &&
      (!form.acpEnabled ||
        (item.acp?.command === form.acpCommand &&
          JSON.stringify(item.acp.startupArgs) === JSON.stringify(splitCommandArgs(form.acpStartupArgs)))),
  );
  const tool =
    selected?.label ??
    (form.clientId === 'openai'
      ? 'Codex'
      : form.clientId === 'anthropic'
        ? 'Claude Code'
        : form.clientId === 'acp'
          ? 'ACP'
          : form.clientId);
  const native = form.configurationSource === 'native_tool';
  const availableAccounts = filterAccounts(form.clientId, accounts),
    identity = availableAccounts.find((item) => item.id === form.accountRef);
  const { catalog, loading: catalogLoading } = useRuntimeCatalog(
    selected?.id,
    editing ? form.catId : undefined,
    form.accountRef,
    form.defaultModel,
    refresh,
    form.cliConfigArgs.length > 0,
  );
  const defaultModel = catalog?.defaultModel ?? (!form.accountRef ? selected?.configuredModel : undefined);
  const defaultModelLabel =
    catalog?.defaultModelLabel ?? catalog?.models.find((item) => item.value === defaultModel)?.label ?? defaultModel;
  const defaultEffort = catalog?.defaultEffort ?? (!form.accountRef ? selected?.configuredEffort : undefined);
  const models = catalog?.models.length
    ? catalog.models
    : (form.accountRef ? (identity?.models ?? []) : (selected?.models ?? [])).map((value) => ({ value, label: value }));
  const model = form.defaultModel || defaultModel;
  const capabilityModel = form.clientId === 'anthropic' ? (model || 'default').replace(/\[1m\]$/, '') : model;
  const activeModel =
    catalog?.models.find((item) => item.value === model) ??
    catalog?.models.find((item) => item.value === capabilityModel);
  const efforts = catalog?.effortOptions ?? activeModel?.efforts;
  const invalidEffort =
    catalog?.status === 'live' &&
    efforts !== undefined &&
    !!form.cliEffort &&
    !efforts.some((item) => item.value === form.cliEffort);
  useEffect(() => onValidityChange?.(!invalidEffort), [invalidEffort, onValidityChange]);
  const follow = t(native ? `跟随 ${tool} 设置` : '跟随连接设置', `Follow ${native ? tool : 'connection'} settings`);
  const accountOptions = [
    { value: '', label: t(`使用 ${tool} 当前配置`, `Use current ${tool} configuration`), disabled: false },
    ...availableAccounts.map((item) => ({
      value: item.id,
      label: item.displayName || item.name,
      disabled: native && item.authType === 'oauth' && item.id !== builtinAccountIdForClient(form.clientId),
    })),
  ];
  if (form.accountRef && !identity)
    accountOptions.push({
      value: form.accountRef,
      label: `${form.accountRef} · ${t('暂不可读取', 'Unavailable')}`,
      disabled: false,
    });
  const applyTool = (next: RuntimeChoice) => {
    patch({
      clientId: next.clientId,
      accountRef: '',
      configurationSource: 'native_tool',
      defaultModel: '',
      cliEffort: '',
      cliConfigArgs: [],
      codexCarrier: next.clientId === 'openai' ? 'app_server' : '',
      acpEnabled: !!next.acp,
      ...(next.acp
        ? {
            acpCommand: next.acp.command,
            acpStartupArgs: serializeCommandArgs(next.acp.startupArgs),
            acpTransport: next.acp.transport ?? 'stdio',
          }
        : {}),
    });
    setPendingTool(null);
  };
  const choices = runtimes.map((item) => ({
    value: item.id,
    label: `${item.label} · ${item.installed ? t('已安装', 'Installed') : t('未找到', 'Not found')}`,
  }));
  if (!selected) choices.unshift({ value: 'current', label: `${tool} · ${t('当前配置', 'Current configuration')}` });
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">{t('模型与工具', 'Model & tool')}</h2>
        <button
          type="button"
          onClick={() => setRefresh((value) => value + 1)}
          disabled={loading || catalogLoading}
          className="min-h-10 text-sm text-cafe-accent disabled:opacity-50"
        >
          {loading || catalogLoading ? t('读取中…', 'Loading…') : t('刷新', 'Refresh')}
        </button>
      </div>
      <SelectField
        label={t('使用工具', 'Tool')}
        value={selected?.id ?? 'current'}
        options={choices}
        onChange={(value) => {
          const next = runtimes.find((item) => item.id === value);
          if (!next || next.id === selected?.id) return;
          if (editing || form.accountRef || form.defaultModel || form.cliEffort) setPendingTool(next);
          else applyTool(next);
        }}
      />
      {error && (
        <p role="alert" className="text-sm text-conn-red-text">
          {t(
            '工具列表读取失败，现有配置已保留。请刷新重试。',
            'Could not read tools. Your configuration is preserved. Retry with Refresh.',
          )}
        </p>
      )}
      {pendingTool && (
        <div role="alert" className="rounded-xl border border-[var(--console-border-soft)] p-4 text-sm">
          <p>
            {t(
              `切换为 ${pendingTool.label}，模型和思考强度将跟随该工具。当前账号绑定和额外启动参数将清除，伙伴资料保留。`,
              `Switch to ${pendingTool.label} and follow its defaults. Clear the account binding and extra launch arguments; keep this teammate’s profile.`,
            )}
          </p>
          <div className="mt-2 flex gap-4">
            <button type="button" onClick={() => applyTool(pendingTool)} className="min-h-10 text-cafe-accent">
              {t('切换工具', 'Switch tool')}
            </button>
            <button type="button" onClick={() => setPendingTool(null)}>
              {t('取消', 'Cancel')}
            </button>
          </div>
        </div>
      )}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <MemberChoicePicker
          label={t('模型', 'Model')}
          value={form.defaultModel}
          options={models}
          onChange={(defaultModel) => patch({ defaultModel })}
          inheritLabel={follow}
          inheritDetail={defaultModel ? t(`配置：${defaultModelLabel}`, `Configured: ${defaultModelLabel}`) : undefined}
          searchable
          allowCustom
          english={t('zh', 'en') === 'en'}
        />
        <MemberChoicePicker
          label={t('思考强度', 'Reasoning effort')}
          allowCustom={efforts === undefined}
          value={form.cliEffort}
          options={efforts ?? []}
          onChange={(cliEffort) => patch({ cliEffort })}
          inheritLabel={follow}
          inheritDetail={defaultEffort ? t(`配置：${defaultEffort}`, `Configured: ${defaultEffort}`) : undefined}
          english={t('zh', 'en') === 'en'}
        />
      </div>
      <div className="space-y-1 text-sm text-cafe-secondary" role="status">
        {catalogLoading ? (
          <p>{t(`正在读取 ${tool} 的模型…`, `Reading ${tool} models…`)}</p>
        ) : catalog?.status === 'live' ? (
          <p>
            {t(`已读取 ${models.length} 个模型`, `Read ${models.length} models`)}
            {!form.defaultModel && defaultModel
              ? ` · ${t('配置', 'Configured')}：${defaultModelLabel}${defaultEffort ? ` · ${defaultEffort}` : ''}`
              : ''}
          </p>
        ) : (
          <p>
            {catalog?.message === 'account_unavailable'
              ? t(
                  '此连接暂不可读取。已保留当前选择，请在“管理连接”中检查。',
                  'This connection is unavailable. Your selection is preserved; check Manage connections.',
                )
              : catalog?.message === 'account_catalog'
                ? t('使用此连接保存的模型清单。', 'Using the model list saved with this connection.')
                : catalog?.message === 'custom_startup'
                  ? t(
                      '此成员使用自定义启动配置，请按工具支持的模型选择或手动指定。',
                      'This teammate uses a custom launch configuration; select or specify a supported model.',
                    )
                  : t(
                      '模型目录暂不可读取。可以继续跟随工具，或保留已有模型；稍后刷新重试。',
                      'Model catalog unavailable. Keep inherited or saved settings, or retry with Refresh.',
                    )}
          </p>
        )}
        {!catalogLoading && efforts?.length === 0 && !form.cliEffort && (
          <p>{t('此模型未提供单独的思考强度选项。', 'This model does not expose a separate effort setting.')}</p>
        )}
        {invalidEffort && (
          <p role="alert" className="text-conn-red-text">
            {t(
              `当前模型不支持已选强度 ${form.cliEffort}，请选择其他强度或跟随工具。`,
              `This model does not support ${form.cliEffort}. Choose another level or follow the tool.`,
            )}
          </p>
        )}
      </div>
      <div className="border-t border-[var(--console-border-soft)] pt-4">
        {accountOptions.length > 1 ? (
          <SelectField
            label={t('使用连接', 'Connection')}
            value={form.accountRef}
            options={accountOptions}
            onChange={(accountRef) => patch({ accountRef })}
          />
        ) : (
          <p className="text-sm text-cafe-secondary">
            {t(`使用 ${tool} 当前配置`, `Using current ${tool} configuration`)}
          </p>
        )}
        <Link href={accountHref} className="mt-1 inline-flex min-h-10 items-center text-sm text-cafe-accent">
          {t('管理连接', 'Manage connections')} →
        </Link>
      </div>
      <details className="text-sm text-cafe-secondary">
        <summary className="min-h-10 cursor-pointer py-2">{t('配置详情', 'Configuration details')}</summary>
        <p className="mb-3">
          {t(
            '只调整这位伙伴的偏好。安装状态和模型目录不代表调用已验证。',
            'Changes apply to this teammate. Installation and model discovery do not verify an invocation.',
          )}
        </p>
        <SelectField
          label={t('默认值来源', 'Default source')}
          value={form.configurationSource ?? 'managed_account'}
          options={[
            { value: 'native_tool', label: t('工具配置', 'Tool configuration') },
            { value: 'managed_account', label: t('已有连接配置', 'Existing connection configuration') },
          ]}
          onChange={(value) => patch({ configurationSource: value as HubCatEditorFormState['configurationSource'] })}
        />
      </details>
    </div>
  );
}
