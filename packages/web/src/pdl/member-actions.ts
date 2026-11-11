import {
  type AssetCanonItem,
  type CharacterAssetBinding,
  defaultAcpPoolMaxProcesses,
  type MemberVisualAssets,
  type PluginManagerDetail,
  type PluginManagerDetailResponse,
} from '@cat-cafe/shared';
import type { CoCreatorConfig, ConfigData } from '@/components/config-viewer-types';
import { buildNativeCreationPayload } from '@/components/first-run-quest/native-creation-payload';
import {
  type NativePartner,
  nativeRuntimeSelectable,
  recommendNativePartners,
} from '@/components/first-run-quest/native-onboarding';
import type { TemplateCard } from '@/components/first-run-quest/TemplateStep';
import type { AccountsResponse } from '@/components/hub-accounts.types';
import { serializeCommandArgs } from '@/components/hub-cat-editor.acp';
import { uploadAvatarAsset } from '@/components/hub-cat-editor.client';
import {
  autoSlug,
  buildStrategyPayload,
  CLIENT_OPTIONS,
  type CodexRuntimeSettings,
  carrierOptionsForClient,
  filterAccounts,
  type HubCatEditorFormState,
  initialState,
  type StrategyFormState,
  toCodexRuntimeSettings,
  toStrategyForm,
} from '@/components/hub-cat-editor.model';
import type { CatStrategyEntry } from '@/components/hub-strategy-types';
import {
  type MemberDraft,
  persistMemberDraft,
  readMemberDraft,
  templateForm,
} from '@/components/settings/members/member-editor-state';
import { type RuntimeChoice, runtimeDefaults } from '@/components/settings/members/member-runtime-draft';
import { memberRuntimeTools } from '@/components/settings/members/member-runtime-tools';
import { saveMemberExtras } from '@/components/settings/members/member-save-extras';
import { saveMemberRecord } from '@/components/settings/members/member-save-record';
import { prepareNativeMember } from '@/components/settings/members/prepare-native-member';
import type { MemberCatalog } from '@/components/settings/members/useRuntimeCatalog';
import { agentClientConfigurationError } from '@/components/settings/plugin-manager/PluginAgentClientsField';
import { configurationRequest } from '@/components/settings/plugin-manager/plugin-manager-live-api';
import type { AgentClientLibrary, AgentClientProfile } from '@/hooks/useAgentClientLibraries';
import { type CatData, refreshCatsNow, saveCatOrder } from '@/hooks/useCatData';
import { primeCoCreatorConfigCache } from '@/hooks/useCoCreatorConfig';
import { API_URL, apiFetch } from '@/utils/api-client';
import { apiSessionIdentity } from '@/utils/api-session-identity';
import { beginMemberSave } from '@/utils/member-save-trace';
import { request, write } from './owner-api';

interface MemberCanonRead {
  avatar?: string;
  visualAssets: MemberVisualAssets;
  history: CharacterAssetBinding[];
  nextHistoryAfter?: number;
  candidates: { items: AssetCanonItem[]; nextAfter?: number };
}
export async function readMemberCanon(id: string, threadId: string) {
  const path = `/api/cats/${encodeURIComponent(id)}/canon-avatar`;
  const source = await request<MemberCanonRead>(path);
  let after = source.candidates.nextAfter,
    historyAfter = source.nextHistoryAfter;
  while (after !== undefined || historyAfter !== undefined) {
    const page = await request<MemberCanonRead>(
      `${path}?${new URLSearchParams({ after: String(after ?? 0), historyAfter: String(historyAfter ?? 0) })}`,
    );
    if (after !== undefined) source.candidates.items.push(...page.candidates.items);
    if (historyAfter !== undefined) source.history.push(...page.history);
    after = after === undefined ? undefined : page.candidates.nextAfter;
    historyAfter = historyAfter === undefined ? undefined : page.nextHistoryAfter;
  }
  const candidates = source.candidates.items;
  let cursor: number | undefined = 0;
  let snapshot: string | undefined;
  do {
    const page: { items: AssetCanonItem[]; nextAfter?: number; snapshot: string } = await write('/api/works/command', {
      threadId,
      command: {
        action: 'list-assets',
        memberAvatarCatId: id,
        includeSuperseded: true,
        after: cursor,
        limit: 50,
        ...(snapshot ? { snapshot } : {}),
      },
    });
    candidates.push(
      ...page.items.filter(
        (item) => !candidates.some((existing) => existing.record.indexedVersionRef === item.record.indexedVersionRef),
      ),
    );
    cursor = page.nextAfter;
    snapshot = page.snapshot;
  } while (cursor !== undefined);
  const previousRefs = [
    ...new Set(source.history.flatMap((binding) => (binding.indexedVersionRef ? [binding.indexedVersionRef] : []))),
  ].filter((ref) => !candidates.some((item) => item.record.indexedVersionRef === ref));
  candidates.push(
    ...(await Promise.all(
      previousRefs.map((indexedVersionRef) =>
        write<AssetCanonItem>('/api/works/command', {
          threadId,
          command: { action: 'read-asset', indexedVersionRef },
        }),
      ),
    )),
  );
  const versions = await Promise.all(
    candidates.map(async ({ record }) => {
      let supersededReason = '';
      if (record.supersededBy) {
        const history: { operationId: string; reason: string }[] = [];
        let after: number | undefined = 0;
        do {
          const page: { history: typeof history; nextAfter?: number } = await write('/api/works/command', {
            threadId,
            command: { action: 'read-asset-history', indexedVersionRef: record.indexedVersionRef, after, limit: 50 },
          });
          history.push(...page.history);
          after = page.nextAfter;
        } while (after !== undefined);
        supersededReason = history.find(
          (event) => `supersession:${event.operationId}` === record.supersededBy!.eventRef,
        )!.reason;
      } else if (record.indexedVersionRef !== source.visualAssets.indexedVersionRef) {
        const index = source.history.map((binding) => binding.indexedVersionRef).lastIndexOf(record.indexedVersionRef);
        if (index >= 0 && index + 1 < source.history.length) supersededReason = source.history[index + 1].reason;
      }
      return {
        id: record.indexedVersionRef,
        label: record.name,
        at: record.version.recordedAt,
        assetRevision: record.revision,
        supersededReason,
      };
    }),
  );
  return {
    avatar: source.avatar,
    bound: source.visualAssets.state !== 'unlinked',
    bindingRevision: source.visualAssets.bindingRevision,
    current: source.visualAssets.indexedVersionRef,
    versions,
  };
}
export async function saveMemberCanon(id: string, threadId: string, body: string, file?: File) {
  const input = JSON.parse(body);
  const path = `/api/cats/${encodeURIComponent(id)}/canon-avatar`;
  if (file) await write(`${path}/upload`, { ...input, uploadUrl: await uploadAvatarAsset(file) });
  else await write(path, { ...input, mode: 'set' });
  await refreshCatsNow();
  return readMemberCanon(id, threadId);
}

export async function readMemberSettings() {
  const [accounts, templates, snapshot, strategies, discovered, libraries] = await Promise.all([
    request<AccountsResponse>('/api/accounts'),
    request<{ templates: TemplateCard[] }>('/api/cat-templates'),
    request<{ config: ConfigData }>('/api/config'),
    request<{ cats: CatStrategyEntry[] }>('/api/config/session-strategy'),
    request<{ runtimes: RuntimeChoice[] }>('/api/cats/native-runtimes'),
    request<{ libraries: AgentClientLibrary[] }>('/api/agent-providers'),
  ]);
  return {
    accounts: accounts.providers,
    templates: templates.templates,
    blank: initialState(),
    codex: toCodexRuntimeSettings(snapshot.config),
    strategies: strategies.cats.map((entry) => ({ id: entry.catId, form: toStrategyForm(entry) })),
    libraries: libraries.libraries,
    runtimes: memberRuntimeTools(discovered.runtimes, libraries.libraries).map((runtime) => ({
      ...runtime,
      acpMaxDefault: defaultAcpPoolMaxProcesses(runtime.clientId),
      form: runtimeDefaults(runtime),
    })),
    clients: CLIENT_OPTIONS.map((client) => ({
      id: client.value,
      acpMaxDefault: defaultAcpPoolMaxProcesses(client.value),
      label: client.label,
      carriers: carrierOptionsForClient(client.value).map((mode) => [mode.value, mode.label]),
      accounts: filterAccounts(client.value, accounts.providers).map((account) => account.id),
    })),
  };
}

export async function saveMemberStrategy(catId: string, form: StrategyFormState) {
  const entry = await write<CatStrategyEntry>(
    `/api/config/session-strategy/${encodeURIComponent(catId)}`,
    { ...buildStrategyPayload(form), expectedRevision: form.overrideRevision },
    'PATCH',
  );
  return toStrategyForm(entry);
}

export async function runMemberProviderSetup(op: string, body: string) {
  const response = await apiFetch(`/api/cats/dsh-setup/${op}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  const receipt = await response.json();
  if (!response.ok) throw Object.assign(new Error(receipt.error), { profiles: receipt.profiles });
  return op === 'prepare'
    ? {
        ...receipt,
        launch: {
          acpCommand: receipt.command,
          acpStartupArgs: serializeCommandArgs(receipt.startupArgs),
          defaultModel: '',
          cliEffort: '',
        },
      }
    : receipt;
}

export function readMemberRuntimeModels(body: string) {
  return request<MemberCatalog>(JSON.parse(body).ref ? '/api/agent-providers/models' : '/api/cats/runtime-models', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

export async function readNativeMembers(journeyId: string, refresh: boolean) {
  const [discovered, templates, roster, accounts] = await Promise.all([
    request<{ runtimes: RuntimeChoice[] }>(`/api/cats/native-runtimes${refresh ? '?refresh=1' : ''}`),
    request<{ templates: TemplateCard[] }>('/api/cat-templates'),
    request<{ cats: CatData[] }>('/api/cats'),
    request<AccountsResponse>('/api/accounts'),
  ]);
  return recommendNativePartners(discovered.runtimes, templates.templates, roster.cats, journeyId).map((partner) => ({
    ...partner,
    runtime: { ...partner.runtime, acpMaxDefault: defaultAcpPoolMaxProcesses(partner.runtime.clientId) },
    form:
      !partner.existingId && partner.runtime.agyCarrier
        ? { ...partner.form, agyTrustedWorkspaces: accounts.projectPath }
        : partner.form,
    selectable: nativeRuntimeSelectable(partner.runtime, partner.form),
  }));
}

/** A DSH Desktop partner is prepared (private Desktop configuration) before it is created; the prepared form is kept by
 * the caller so a retry sends the same body under the same idempotency key. */
export function prepareNativePartner(partner: NativePartner) {
  return prepareNativeMember(partner.form, undefined, partner.runtime);
}

export async function createNativeMember(partner: NativePartner, journeyId: string) {
  const receipt = await request<{ cat: CatData }>('/api/cats', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Cat-Cafe-Onboarding-Journey': journeyId,
      'Idempotency-Key': `onboarding:${journeyId}:cat:${partner.creationRequestKey}`,
    },
    body: JSON.stringify(buildNativeCreationPayload(partner.creationForm ?? partner.form)),
  });
  await refreshCatsNow();
  return receipt.cat;
}

export async function readMemberClientSettings(pluginId: string) {
  const result = await request<PluginManagerDetailResponse>(
    `/api/plugin-manager/plugins/${encodeURIComponent(pluginId)}`,
  );
  return result.plugin;
}

export async function saveMemberClientSettings(
  plugin: PluginManagerDetail,
  key: string,
  value: string,
  fixedClient?: AgentClientProfile,
) {
  const error = agentClientConfigurationError(value, fixedClient);
  if (error) throw new Error(error);
  const command = configurationRequest(plugin, [{ key, value }]);
  if (!command) throw new Error('该插件没有可用的配置贡献');
  await request(command.path, command.init);
  return readMemberClientSettings(plugin.pluginId);
}

export async function pickMemberTemplate(id: string, form: HubCatEditorFormState, cats: CatData[]) {
  if (id === 'blank') return { ...initialState(), avatar: form.avatar };
  const { templates } = await request<{ templates: TemplateCard[] }>('/api/cat-templates');
  const template = templates.find((row) => row.id === id);
  if (!template) throw new Error('memberNew.templatesError');
  return { ...templateForm(template, cats, form), avatar: form.avatar };
}

export async function saveMemberOrder(keys: string[], cats: CatData[]) {
  const selected = new Set(keys);
  const slots = cats.flatMap((cat, i) => (selected.has(cat.id) ? [i] : []));
  if (keys.length !== selected.size || slots.length !== keys.length) throw new Error('members.loadError');
  const order = cats.map((cat) => cat.id);
  slots.forEach((slot, i) => {
    order[slot] = keys[i];
  });
  await saveCatOrder(order);
}

export interface MemberSaveUpdate {
  key: string;
  state: 'idle' | 'saving' | 'checking';
  draft: MemberDraft;
  baselineForm: HubCatEditorFormState;
  error: string;
}

export async function saveMember(
  form: HubCatEditorFormState,
  baseline: CatData | null,
  expectedRevision: string | undefined,
  shared?: Pick<CodexRuntimeSettings, 'sandboxMode' | 'approvalPolicy'> & { baseline: CodexRuntimeSettings },
  changed?: (update: MemberSaveUpdate) => void,
) {
  const accounts = await request<AccountsResponse>('/api/accounts');
  const account = filterAccounts(form.clientId, accounts.providers).find((row) => row.id === form.accountRef);
  if (form.accountRef && !account) throw new Error('runtime.readError');
  const context = { accountAuthType: account?.authType ?? null };
  const value = baseline
    ? form
    : { ...form, catId: form.catId || autoSlug(form.mentionPatterns.split(',')[0] || form.name) };
  const prefix = `member-draft:v1:${API_URL}:${apiSessionIdentity.getSnapshot().ownerUserId}:${accounts.projectPath}:`;
  const sourceKey = baseline?.id ?? 'new';
  let key = prefix + sourceKey;
  const cached = readMemberDraft(key);
  const observed = cached ? cached.baseline : baseline;
  if (observed && observed.configurationRevision !== expectedRevision)
    throw Object.assign(new Error('runtime.readError'), { code: 'configuration_revision_conflict' });
  const snapshot: MemberDraft = {
    ...cached,
    version: 1,
    form: value,
    baseline: cached ? cached.baseline : baseline,
    templateId: null,
    section: 'runtime',
    ...(shared
      ? {
          codexBaseline: shared.baseline,
          codexSettings: { ...shared.baseline, sandboxMode: shared.sandboxMode, approvalPolicy: shared.approvalPolicy },
        }
      : {}),
  };
  let retained = snapshot;
  let phase: MemberSaveUpdate['state'] = snapshot.pendingWrite ? 'checking' : 'saving';
  const publish = (error = '') =>
    changed?.({ key: sourceKey, state: phase, draft: retained, baselineForm: initialState(retained.baseline), error });
  const commit = (draft: MemberDraft) => {
    const nextKey = prefix + (draft.baseline?.id ?? sourceKey);
    if (nextKey !== key) {
      persistMemberDraft(key, null);
      key = nextKey;
    }
    retained = draft;
    persistMemberDraft(key, draft);
    phase = 'saving';
    publish();
  };
  const trace = beginMemberSave(API_URL, apiFetch);
  publish();
  try {
    const cat = await saveMemberRecord({ snapshot, form: value, context, trace, commit, conflict: trace.fail });
    await saveMemberExtras(snapshot, cat, trace, commit);
    persistMemberDraft(key, null);
    await refreshCatsNow();
    phase = 'idle';
    publish();
    return cat;
  } catch (error) {
    const failure = error as Error & { code?: string };
    const code =
      failure.code ??
      (retained.pendingWrite
        ? phase === 'checking'
          ? 'member_write_unavailable'
          : 'member_write_unconfirmed'
        : failure.message);
    if (retained.baseline && retained.baseline.configurationRevision !== baseline?.configurationRevision)
      await refreshCatsNow();
    phase = 'idle';
    publish(code);
    throw error;
  } finally {
    trace.finish();
  }
}

export async function removeMember(id: string, expectedRevision: string) {
  await write(`/api/cats/${encodeURIComponent(id)}`, { expectedRevision }, 'DELETE');
  await refreshCatsNow();
}

export async function setMemberAvailable(cat: CatData, available: boolean) {
  await write(
    `/api/cats/${encodeURIComponent(cat.id)}`,
    { available, expectedRevision: cat.configurationRevision },
    'PATCH',
  );
  await refreshCatsNow();
}

export async function saveOwner(
  value: Pick<CoCreatorConfig, 'name' | 'aliases' | 'mentionPatterns' | 'avatar' | 'color'> & {
    nickname?: string | null;
  },
) {
  const receipt = await write<{ config: ConfigData & { coCreator: CoCreatorConfig } }>(
    '/api/config/co-creator',
    value,
    'PATCH',
  );
  primeCoCreatorConfigCache(receipt.config.coCreator);
  return receipt.config.coCreator;
}
