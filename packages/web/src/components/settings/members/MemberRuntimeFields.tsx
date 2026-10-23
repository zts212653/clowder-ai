'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAgentClientLibraries } from '@/hooks/useAgentClientLibraries';
import { apiFetch } from '@/utils/api-client';
import type { ProfileItem } from '../../hub-accounts.types';
import { usesAgyAcp, usesAgyNative } from '../../hub-cat-editor.agy';
import {
  builtinAccountIdForClient,
  filterAccounts,
  type HubCatEditorFormState,
  splitCommandArgs,
} from '../../hub-cat-editor.model';
import { SelectField } from '../../hub-cat-editor-fields';
import { MemberChoicePicker } from './MemberChoicePicker';
import { MemberConfigurationDetails } from './MemberConfigurationDetails';
import { MemberDshProviderSetup } from './MemberDshProviderSetup';
import { MemberToolSelector } from './MemberToolSelector';
import type { MemberRuntimeContext } from './member-runtime-context';
import { matchesRuntime, type RuntimeChoice, type RuntimeDrafts, runtimeDefaults } from './member-runtime-draft';
import { memberRuntimeName, memberRuntimeTools, type RuntimeEdition } from './member-runtime-tools';
import { nativeAcpProfileMessage } from './native-acp-profile-status';
import { usesDefaultNativeIdentity } from './native-login-state';
import { useMemberRuntimeContext } from './useMemberRuntimeContext';
import { useRuntimeCatalog } from './useRuntimeCatalog';
export type MemberText = (zh: string, en: string) => string;
export function MemberRuntimeFields({
  form,
  accounts,
  patch,
  onToolChange,
  runtimeDrafts,
  runtimeContext,
  onRuntimeContextChange,
  t,
  accountHref,
  editing,
  onValidityChange,
  nativeSetup = false,
}: {
  form: HubCatEditorFormState;
  accounts: ProfileItem[];
  patch: (value: Partial<HubCatEditorFormState>) => void;
  onToolChange?: (tool: RuntimeChoice, current?: RuntimeChoice) => void;
  runtimeDrafts?: RuntimeDrafts;
  runtimeContext?: MemberRuntimeContext;
  onRuntimeContextChange?: (context: MemberRuntimeContext) => void;
  t: MemberText;
  accountHref: string;
  editing: boolean;
  onValidityChange?: (valid: boolean) => void;
  /** First-run keeps the detected tool and its existing connection, exposing only model preferences. */
  nativeSetup?: boolean;
}) {
  const [runtimes, setRuntimes] = useState<RuntimeChoice[]>([]),
    [edition, setEdition] = useState<RuntimeEdition>(),
    [error, setError] = useState(false),
    [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0);
  const { libraries: clientLibraries, error: libraryError } = useAgentClientLibraries(String(refresh), !nativeSetup);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    apiFetch(`/api/cats/native-runtimes${refresh ? '?refresh=1' : ''}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw Error('discovery');
        return (await response.json()) as { runtimes: RuntimeChoice[]; edition?: RuntimeEdition };
      })
      .then((data) => {
        if (!controller.signal.aborted) {
          setRuntimes(data.runtimes);
          setEdition(data.edition ?? 'public');
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [refresh]);
  const tools = memberRuntimeTools(runtimes, clientLibraries, runtimeDrafts, edition);
  const selected = tools.find((item) => matchesRuntime(form, item));
  const current = useMemberRuntimeContext(form, selected, runtimeContext, onRuntimeContextChange);
  const agy = usesAgyNative(form) || usesAgyAcp(form);
  const tool = memberRuntimeName(form, current, t);
  const native = form.configurationSource === 'native_tool';
  const availableAccounts = filterAccounts(form.clientId, accounts),
    identity = availableAccounts.find((item) => item.id === form.accountRef);
  const defaultIdentity = usesDefaultNativeIdentity(form);
  const needsLogin = defaultIdentity && selected?.readiness?.status === 'login_required';
  const { catalog, loading: catalogLoading } = useRuntimeCatalog(
    needsLogin ||
      selected?.id.startsWith('draft:') ||
      selected?.id.startsWith('manual:') ||
      selected?.id.startsWith('plugin:')
      ? undefined
      : selected?.id,
    editing ? form.catId : undefined,
    form.accountRef,
    form.defaultModel,
    refresh,
    form.cliConfigArgs.length > 0,
    JSON.stringify([form.acpCommand, splitCommandArgs(form.acpStartupArgs), form.acpTransport, form.acpAgentProvider]),
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
  const invalidRuntime = selected?.discoveryStatus === 'acp_profile_invalid';
  useEffect(
    () => onValidityChange?.(!invalidEffort && !invalidRuntime),
    [invalidEffort, invalidRuntime, onValidityChange],
  );
  const follow = t(native ? `跟随 ${tool} 设置` : '跟随连接设置', `Follow ${native ? tool : 'connection'} settings`);
  const accountOptions = [
    {
      value: '',
      label: agy
        ? t('使用隔离 Profile 的个人登录', 'Use personal sign-in in the isolated Profile')
        : t(`使用 ${tool} 当前配置`, `Use current ${tool} configuration`),
      disabled: false,
    },
    ...availableAccounts.map((item) => ({
      value: item.id,
      label: item.displayName || item.name,
      disabled:
        (agy && item.authType === 'api_key') ||
        (native && item.authType === 'oauth' && item.id !== builtinAccountIdForClient(form.clientId)),
    })),
  ];
  if (form.accountRef && !identity)
    accountOptions.push({
      value: form.accountRef,
      label: `${form.accountRef} · ${t('暂不可读取', 'Unavailable')}`,
      disabled: false,
    });
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
      {!nativeSetup && (
        <MemberToolSelector
          tools={tools}
          selected={selected}
          current={current}
          tool={tool}
          edition={edition}
          loading={loading}
          t={t}
          onChange={(next) => {
            if (onToolChange) onToolChange(next, current);
            else patch(runtimeDefaults(next));
          }}
        />
      )}
      {error && (
        <p role="alert" className="text-sm text-conn-red-text">
          {t(
            '工具列表读取失败，现有配置已保留。请刷新重试。',
            'Could not read tools. Your configuration is preserved. Retry with Refresh.',
          )}
        </p>
      )}
      {form.acpAgentProvider && (
        <p className="text-sm text-cafe-secondary">
          {t(
            '启动配置来自插件，认证与默认模型由 client 管理；实际连接待验证。',
            'Launch settings come from the plugin. The client owns authentication and model defaults; connection is not yet verified.',
          )}
        </p>
      )}
      {libraryError && (
        <p role="alert" className="text-sm text-cafe-secondary">
          {libraryError}
        </p>
      )}
      {clientLibraries
        .filter((library) => library.error)
        .map((library) => (
          <p key={library.pluginId} role="alert" className="text-sm text-cafe-secondary">
            {library.pluginId}: {library.error}
          </p>
        ))}
      {needsLogin && (
        <div role="status" className="rounded-xl bg-conn-amber-bg p-4 text-sm text-conn-amber-text">
          <p className="font-semibold">{t(`${tool} 尚未登录`, `${tool} is not signed in`)}</p>
          <p className="mt-2">
            {t(
              '先在此运行环境登录工具，再点击刷新。配置可以保存，但登录前无法回复。',
              'Sign in to the tool in this runtime environment, then refresh. You can save the configuration, but it cannot reply before sign-in.',
            )}
          </p>
          <code className="mt-2 block">{selected?.readiness?.loginCommand}</code>
        </div>
      )}
      {defaultIdentity && selected?.readiness?.status === 'configured' && (
        <p className="text-sm text-cafe-secondary">
          {t('已检测登录 · 实际连接待验证', 'Sign-in detected · Connection not yet verified')}
        </p>
      )}
      <MemberDshProviderSetup form={form} selected={selected} patch={patch} t={t} />
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
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
        {form.acpAgentProvider ? (
          <p>
            {t(
              '默认使用客户端当前模型；也可手动填写该客户端支持的模型 ID。',
              'Uses the client model by default. You can also enter a model ID supported by that client.',
            )}
          </p>
        ) : needsLogin ? (
          <p>
            {t(
              '登录后可读取模型目录；当前可以保留跟随工具设置。',
              'Sign in to read the model catalog; inherited settings can be kept for now.',
            )}
          </p>
        ) : catalogLoading ? (
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
            {nativeAcpProfileMessage(catalog?.message, t) ||
              (catalog?.message === 'account_unavailable'
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
                      ))}
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
      {!nativeSetup && agy && (
        <p className="text-sm text-cafe-secondary">
          {t(
            '身份使用“高级接入”中的隔离 Profile；个人登录与执行权限也在那里配置。保存不会登录或调用模型。',
            'Identity uses the isolated Profile in Advanced connection. Configure personal sign-in and execution permissions there. Saving does not sign in or call a model.',
          )}
        </p>
      )}
      {!nativeSetup && (
        <div className="border-t border-[var(--console-border-soft)] pt-4">
          {accountOptions.length > 1 ? (
            <SelectField
              label={t('使用连接', 'Connection')}
              value={form.accountRef}
              options={accountOptions}
              onChange={(accountRef) => patch({ accountRef })}
            />
          ) : !agy ? (
            <p className="text-sm text-cafe-secondary">
              {t(`使用 ${tool} 当前配置`, `Using current ${tool} configuration`)}
            </p>
          ) : null}
          {!agy && (
            <Link href={accountHref} className="mt-1 inline-flex min-h-10 items-center text-sm text-cafe-accent">
              {t('管理连接', 'Manage connections')} →
            </Link>
          )}
        </div>
      )}
      {!nativeSetup && (
        <MemberConfigurationDetails
          form={form}
          patch={patch}
          defaultIdentity={defaultIdentity}
          readiness={selected?.readiness}
          t={t}
        />
      )}
    </div>
  );
}
