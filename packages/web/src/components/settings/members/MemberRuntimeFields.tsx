'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useAgentClientLibraries } from '@/hooks/useAgentClientLibraries';
import {
  isDshMember,
  memberModelCatalogKey,
  memberModelValueLabel,
  useMemberModelCatalogs,
} from '@/lib/member-model-display';
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
import { MemberCatalogStatus } from './MemberCatalogStatus';
import { MemberChoicePicker } from './MemberChoicePicker';
import { MemberConfigurationDetails } from './MemberConfigurationDetails';
import { MemberDshProviderSetup } from './MemberDshProviderSetup';
import { MemberModelSummary } from './MemberModelSummary';
import { matchesRuntime, type RuntimeChoice, type RuntimeDrafts, runtimeDefaults } from './member-runtime-draft';
import { memberRuntimeOptions, memberRuntimeTools } from './member-runtime-tools';
import { usesDefaultNativeIdentity } from './native-login-state';
import { useRuntimeCatalog } from './useRuntimeCatalog';
export type MemberText = (zh: string, en: string) => string;
export function MemberRuntimeFields({
  form,
  accounts,
  patch,
  onToolChange,
  runtimeDrafts,
  t,
  accountHref,
  editing,
  onValidityChange,
  nativeSetup = false,
  preparedRuntime: draftPreparedRuntime,
}: {
  form: HubCatEditorFormState;
  accounts: ProfileItem[];
  patch: (value: Partial<HubCatEditorFormState>) => void;
  onToolChange?: (tool: RuntimeChoice) => void;
  runtimeDrafts?: RuntimeDrafts;
  t: MemberText;
  accountHref: string;
  editing: boolean;
  onValidityChange?: (valid: boolean) => void;
  /** First-run keeps the detected tool and its existing connection, exposing only model preferences. */
  nativeSetup?: boolean;
  preparedRuntime?: RuntimeChoice;
  onPreparedRuntime?: (runtime: RuntimeChoice) => void;
}) {
  const runtimes = useMemberModelCatalogs((state) => state.runtimes);
  const [error, setError] = useState(false),
    [loading, setLoading] = useState(true),
    [refresh, setRefresh] = useState(0);
  const preparedRuntime = draftPreparedRuntime;
  const preparedSelected = preparedRuntime !== undefined && matchesRuntime(form, preparedRuntime);
  const runtimeEvidence = useMemo(
    () => (preparedSelected && preparedRuntime ? [...runtimes, preparedRuntime] : runtimes),
    [runtimes, preparedRuntime, preparedSelected],
  );
  useEffect(() => {
    useMemberModelCatalogs.setState({ preparedRuntime: preparedSelected ? preparedRuntime : undefined });
    return () => useMemberModelCatalogs.setState({ preparedRuntime: undefined });
  }, [preparedRuntime, preparedSelected]);
  const { libraries: clientLibraries, error: libraryError } = useAgentClientLibraries(String(refresh), !nativeSetup);
  useEffect(() => {
    const controller = new AbortController();
    const runtimeRevision = useMemberModelCatalogs.getState().runtimeRevision + 1;
    useMemberModelCatalogs.setState({ runtimeRevision });
    setLoading(true);
    setError(false);
    apiFetch(`/api/cats/native-runtimes${refresh ? '?refresh=1' : ''}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw Error('discovery');
        return (await response.json()) as { runtimes: RuntimeChoice[] };
      })
      .then((data) => {
        if (!controller.signal.aborted) {
          useMemberModelCatalogs.setState((state) =>
            state.runtimeConfirmedRevision <= runtimeRevision
              ? { runtimes: data.runtimes, runtimeConfirmedRevision: runtimeRevision }
              : state,
          );
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
  const tools = memberRuntimeTools(
    preparedSelected && preparedRuntime
      ? runtimes.map((runtime) => (runtime.id === preparedRuntime.id ? preparedRuntime : runtime))
      : [...runtimes],
    clientLibraries,
    runtimeDrafts,
    form,
  );
  const selected = tools.find((item) => matchesRuntime(form, item));
  const agy = usesAgyNative(form) || usesAgyAcp(form);
  const tool =
    (usesAgyAcp(form) ? t('AGY 官方 ACP', 'AGY official ACP') : usesAgyNative(form) ? 'AGY Native' : selected?.label) ??
    (form.clientId === 'openai'
      ? 'Codex'
      : form.clientId === 'anthropic'
        ? 'Claude Code'
        : form.clientId === 'acp'
          ? 'ACP'
          : form.clientId);
  const native = form.configurationSource === 'native_tool';
  const displayMember = {
    id: form.catId,
    clientId: form.clientId,
    agentProvider: form.acpAgentProvider,
    acp: { command: form.acpCommand, startupArgs: splitCommandArgs(form.acpStartupArgs), transport: form.acpTransport },
    accountRef: form.accountRef,
    cliConfigArgs: form.cliConfigArgs,
    env: form.env,
  };
  const dsh = isDshMember(displayMember, runtimeEvidence);
  const automaticDsh = native && !form.accountRef && dsh;
  const english = t('zh', 'en') === 'en';
  const availableAccounts = filterAccounts(form.clientId, accounts),
    identity = availableAccounts.find((item) => item.id === form.accountRef);
  const defaultIdentity = usesDefaultNativeIdentity(form);
  const needsLogin = defaultIdentity && selected?.readiness?.status === 'login_required';
  const catalogNotImplemented = !!(selected?.id.startsWith('draft:') || selected?.id.startsWith('manual:'));
  const { catalog, loading: catalogLoading } = useRuntimeCatalog(
    needsLogin || catalogNotImplemented || automaticDsh ? undefined : selected?.id,
    editing && !automaticDsh ? form.catId : undefined,
    form.accountRef,
    form.defaultModel,
    refresh,
    form.cliConfigArgs.length > 0,
  );
  const displayKey = memberModelCatalogKey(displayMember);
  useEffect(() => {
    if (dsh && catalog)
      useMemberModelCatalogs.setState((state) => ({ catalogs: { ...state.catalogs, [displayKey]: catalog } }));
  }, [dsh, catalog, displayKey]);
  const defaultModel = catalog?.defaultModel ?? (!form.accountRef ? selected?.configuredModel : undefined);
  const configuredModelLabel =
    catalog?.defaultModelLabel ?? catalog?.models.find((item) => item.value === defaultModel)?.label ?? defaultModel;
  const modelLabel = (value: string) => (dsh ? memberModelValueLabel(value, true, catalog?.models, english) : value);
  const defaultModelLabel =
    defaultModel !== undefined
      ? dsh
        ? memberModelValueLabel(defaultModel, true, catalog?.models, english, catalog?.defaultModelLabel)
        : configuredModelLabel
      : undefined;
  const defaultModelSource =
    catalog?.defaultModelSource === 'client_report'
      ? t('客户端回报', 'Client report')
      : t('本地配置', 'Local configuration');
  const models = catalog?.models.length
    ? catalog.models
    : (form.accountRef ? (identity?.models ?? []) : (selected?.models ?? [])).map((value) => ({ value, label: value }));
  const model = form.defaultModel || defaultModel;
  const capabilityModel = form.clientId === 'anthropic' ? (model || 'default').replace(/\[1m\]$/, '') : model;
  const activeModel =
    catalog?.models.find((item) => item.value === model) ??
    catalog?.models.find((item) => item.value === capabilityModel || item.resolvedModel === capabilityModel);
  const usesSelectedEffort = catalog?.selectedEffort !== undefined && catalog.selectedModel === model;
  const defaultEffort = usesSelectedEffort
    ? catalog.selectedEffort
    : !form.defaultModel || form.defaultModel === defaultModel
      ? (catalog?.defaultEffort ?? (!form.accountRef ? selected?.configuredEffort : undefined))
      : undefined;
  const defaultEffortLabel =
    (usesSelectedEffort ? catalog.selectedEffortLabel : catalog?.defaultEffortLabel) ?? defaultEffort;
  const efforts = catalog?.effortOptions ?? activeModel?.efforts;
  const tierlessKimi = form.clientId === 'kimi' && efforts?.length === 0;
  const invalidEffort =
    !tierlessKimi &&
    catalog?.status !== 'unavailable' &&
    catalog?.message !== 'refresh_failed' &&
    efforts !== undefined &&
    !!form.cliEffort &&
    !efforts.some((item) => item.value === form.cliEffort);
  const invalidRuntime = !dsh && selected?.discoveryStatus === 'acp_profile_invalid';
  const invalidDefaultModel = !dsh && native && !form.defaultModel && catalog?.defaultModelStatus === 'unavailable';
  useEffect(
    () => onValidityChange?.(!invalidEffort && !invalidRuntime && !invalidDefaultModel),
    [invalidEffort, invalidRuntime, invalidDefaultModel, onValidityChange],
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
  const choices = memberRuntimeOptions(tools, t);
  if (!selected)
    choices.unshift({
      value: 'current',
      disabled: false,
      label: `${tool} · ${t('当前配置', 'Current configuration')}`,
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
        <SelectField
          label={t('使用工具', 'Tool')}
          value={selected?.id ?? 'current'}
          options={choices}
          onChange={(value) => {
            const next = tools.find((item) => item.id === value);
            if (!next || next.id === selected?.id || next.discoveryStatus === 'acp_profile_invalid') return;
            if (onToolChange) onToolChange(next);
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
            '启动配置来自插件。原生身份入口尚未验证；当前通用 ACP 路径会将系统上下文随用户任务发送。认证与真实调用仍需验证。',
            'Launch settings come from the plugin. Native identity injection is unverified; the generic ACP path sends system context with the user task. Authentication and real invocation still need verification.',
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
      {automaticDsh && <MemberDshProviderSetup form={form} t={t} patch={patch} />}
      <div className="grid gap-4 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        {!automaticDsh && (
          <MemberChoicePicker
            label={t('模型', 'Model')}
            value={form.defaultModel}
            formatValue={modelLabel}
            options={dsh ? models.map((item) => ({ ...item, label: modelLabel(item.value) })) : models}
            onChange={(defaultModel) => patch({ defaultModel })}
            inheritLabel={follow}
            inheritValueLabel={dsh && defaultModelLabel ? `${defaultModelLabel} · ${follow}` : undefined}
            inheritedValue={dsh ? defaultModel : undefined}
            inheritDetail={defaultModel !== undefined ? `${defaultModelSource}：${defaultModelLabel}` : undefined}
            searchable
            allowCustom
            english={t('zh', 'en') === 'en'}
          />
        )}
        <MemberChoicePicker
          label={t('思考强度', 'Reasoning effort')}
          allowCustom={efforts === undefined}
          value={form.cliEffort}
          options={efforts ?? []}
          onChange={(cliEffort) => patch({ cliEffort })}
          inheritLabel={follow}
          inheritDetail={
            defaultEffort !== undefined
              ? t(
                  `配置：${defaultEffortLabel || '客户端默认'}`,
                  `Configured: ${defaultEffortLabel || 'Client default'}`,
                )
              : undefined
          }
          english={t('zh', 'en') === 'en'}
        />
      </div>
      {!automaticDsh && (
        <div className="space-y-1 text-sm text-cafe-secondary" role="status">
          <MemberModelSummary
            model={
              form.defaultModel
                ? dsh
                  ? modelLabel(form.defaultModel)
                  : (activeModel?.label ?? form.defaultModel)
                : defaultModelLabel
            }
            effort={
              tierlessKimi
                ? undefined
                : form.cliEffort ||
                  (catalog?.thinkingEnabled === false ? t('思考已关闭', 'Thinking off') : defaultEffortLabel)
            }
            modelSource={form.defaultModel ? t('成员设置', 'Member preference') : defaultModelSource}
            effortSource={
              form.cliEffort
                ? t('成员设置', 'Member preference')
                : (usesSelectedEffort ? catalog?.selectedEffortSource : catalog?.defaultEffortSource) ===
                    'client_report'
                  ? t('客户端回报', 'Client report')
                  : t('本地配置', 'Local configuration')
            }
            unavailable={catalog?.status === 'unavailable'}
            notImplemented={catalogNotImplemented}
            noEffortOptions={efforts?.length === 0}
            stale={catalog?.message === 'refresh_failed'}
            t={t}
          />
          <MemberCatalogStatus
            catalog={catalog}
            notImplemented={catalogNotImplemented}
            loading={catalogLoading}
            needsLogin={needsLogin}
            invalidDefault={invalidDefaultModel}
            inheritsModel={native && !form.defaultModel}
            tool={tool}
            modelCount={models.length}
            t={t}
          />
          {catalog?.thinkingEnabled === false && (
            <p>
              {t(
                '工具配置已关闭思考；强度偏好不会开启思考。',
                'Thinking is off in the tool configuration; an effort preference does not enable it.',
              )}
            </p>
          )}
          {!catalogLoading && efforts?.length === 0 && !form.cliEffort && (
            <p>{t('此模型未提供单独的思考强度选项。', 'This model does not expose a separate effort setting.')}</p>
          )}
          {tierlessKimi && form.cliEffort && (
            <p>
              {t(
                `已保留强度偏好 ${form.cliEffort}；此模型不采用独立强度覆盖。`,
                `Saved effort ${form.cliEffort} is retained; this model does not apply separate effort overrides.`,
              )}
            </p>
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
      )}
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
