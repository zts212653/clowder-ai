import { serializeCommandArgs } from '../../hub-cat-editor.acp';
import { usesAgyAcp, usesAgyNative } from '../../hub-cat-editor.agy';
import { type HubCatEditorFormState, initialState, splitCommandArgs } from '../../hub-cat-editor.model';
import { resolveDraftCarrier } from './member-carrier-compat';
import type { MemberDraft } from './member-editor-state';
import type { NativeLoginState } from './native-login-state';

export interface RuntimeChoice {
  id: string;
  label: string;
  kind?: 'tool' | 'binding';
  harnessId?: string;
  sourceCatId?: string;
  roleTemplates?: { id: string; priority?: number }[];
  clientId: HubCatEditorFormState['clientId'];
  installed: boolean;
  /** A Host-owned role recommendation, independent of the client carrying it. */
  roleTemplateId?: string;
  priority?: number;
  agyCarrier?: 'native' | 'acp';
  readiness?: NativeLoginState;
  /** An installed DSH default still needs an explicit usable route confirmation. */
  dshSetupRequired?: boolean;
  /** The discovery binding whose launch produced dshSetup; recommendation identity stays the tool. */
  dshSetupRuntimeId?: string;
  /** Read-only route evidence; member-only preparation happens after the user confirms creation. */
  dshSetup?:
    | { status: 'configured'; sourceProfile: string; revision: string; provider: string; model: string }
    | { status: 'unavailable'; error: string };
  discoveryStatus?: 'configured' | 'acp_profile_missing' | 'acp_profile_invalid' | 'adapter_missing' | 'not_installed';
  models: string[];
  configuredModel?: string;
  modelSource?: 'tool_config' | 'tool_recent';
  defaultsStatus?: 'configured_only' | 'unconfigured' | 'session_only';
  configuredEffort?: string;
  acp?: { agentProvider?: string; command: string; startupArgs: string[]; transport?: 'stdio' | 'httpstream' };
}

const runtimeFields = [
  'clientId',
  'configurationSource',
  'accountRef',
  'defaultModel',
  'cliEffort',
  'cliConfigArgs',
  'commandArgs',
  'carrier',
  'codexSpeed',
  'provider',
  'mcpSupport',
  'acpCommand',
  'acpAgentProvider',
  'acpStartupArgs',
  'acpTransport',
  'acpMaxLiveProcesses',
  'acpIdleTtlMinutes',
  'agyNativeEnabled',
  'agyAcpEnabled',
  'agyProfileEnabled',
  'agyAutoApprove',
  'agyProfileId',
  'agyHomeRoot',
  'agyTrustedWorkspaces',
] as const;
type RuntimeFields = Pick<HubCatEditorFormState, (typeof runtimeFields)[number]>;
export type RuntimeDrafts = Record<string, RuntimeFields & { harnessId?: string }>;

function runtimeKey(form: RuntimeFields): string {
  return JSON.stringify([
    form.clientId,
    resolveDraftCarrier(form) === 'acp'
      ? [form.acpAgentProvider ?? '', form.acpCommand, splitCommandArgs(form.acpStartupArgs), form.acpTransport]
      : null,
  ]);
}

export function matchesRuntime(form: RuntimeFields, choice: RuntimeChoice): boolean {
  if (choice.agyCarrier && !(choice.agyCarrier === 'native' ? usesAgyNative(form) : usesAgyAcp(form))) return false;
  return runtimeKey(form) === runtimeKey(runtimeDefaults(choice));
}

/** Keep undiscovered/custom tools selectable while the user compares tools in this draft. */
export function rememberedRuntimes(drafts: RuntimeDrafts = {}): RuntimeChoice[] {
  return Object.entries(drafts).map(([key, form]) => ({
    id: `draft:${key}`,
    label: usesAgyNative(form)
      ? 'AGY Native'
      : usesAgyAcp(form)
        ? 'AGY 官方 ACP'
        : resolveDraftCarrier(form) === 'acp'
          ? form.acpCommand
          : form.clientId,
    kind: 'binding',
    harnessId: form.harnessId,
    clientId: form.clientId,
    installed: false,
    models: [],
    ...(usesAgyNative(form)
      ? { agyCarrier: 'native' as const }
      : usesAgyAcp(form)
        ? { agyCarrier: 'acp' as const }
        : {}),
    ...(resolveDraftCarrier(form) === 'acp'
      ? {
          acp: {
            ...(form.acpAgentProvider ? { agentProvider: form.acpAgentProvider } : {}),
            command: form.acpCommand,
            startupArgs: splitCommandArgs(form.acpStartupArgs),
            transport: form.acpTransport,
          },
        }
      : {}),
  }));
}

export function runtimeDefaults(next: RuntimeChoice): RuntimeFields {
  const defaults = initialState();
  return {
    ...pickRuntime(defaults),
    clientId: next.clientId,
    configurationSource: 'native_tool',
    accountRef: '',
    defaultModel: '',
    cliEffort: '',
    cliConfigArgs: [],
    commandArgs: '',
    codexSpeed: '',
    provider: '',
    carrier: next.acp ? 'acp' : next.clientId === 'openai' ? 'app_server' : 'cli',
    acpCommand: next.acp?.command ?? '',
    acpAgentProvider: next.acp?.agentProvider ?? null,
    acpStartupArgs: next.acp ? serializeCommandArgs(next.acp.startupArgs) : '',
    acpTransport: next.acp?.transport ?? 'stdio',
    acpMaxLiveProcesses: '',
    acpIdleTtlMinutes: '',
    agyNativeEnabled: next.agyCarrier === 'native',
    agyAcpEnabled: next.agyCarrier === 'acp',
  };
}

function pickRuntime(form: RuntimeFields): RuntimeFields {
  return {
    ...Object.fromEntries(runtimeFields.map((key) => [key, form[key]])),
    carrier: resolveDraftCarrier(form),
  } as RuntimeFields;
}

/** Advanced adapter changes share the tool picker's existing draft history. */
export function patchMemberRuntime(draft: MemberDraft, change: Partial<HubCatEditorFormState>): MemberDraft {
  const form = { ...draft.form, ...change };
  if (resolveDraftCarrier(form) === resolveDraftCarrier(draft.form)) return { ...draft, form };
  const runtimeDrafts = { ...draft.runtimeDrafts, [runtimeKey(draft.form)]: pickRuntime(draft.form) };
  // The adapter picker supplies startup defaults. Prefer the exact binding
  // already carried by this draft when returning to its previous protocol.
  const restored =
    runtimeDrafts[runtimeKey({ ...draft.form, carrier: form.carrier })] ?? runtimeDrafts[runtimeKey(form)];
  return {
    ...draft,
    runtimeDrafts,
    form: {
      ...form,
      ...(restored ? pickRuntime(restored) : {}),
      carrier: form.carrier,
      agyNativeEnabled: form.agyNativeEnabled,
      agyAcpEnabled: form.agyAcpEnabled,
    },
  };
}

/** Switching changes only the draft. Returning to a tool restores its exact binding and overrides. */
export function switchMemberRuntime(draft: MemberDraft, next: RuntimeChoice, current?: RuntimeChoice): MemberDraft {
  const nativeHarness = !draft.form.acpAgentProvider && current?.harnessId;
  if (!next.agyCarrier && next.kind === 'tool' && next.harnessId && next.harnessId === nativeHarness) return draft;
  const defaults = runtimeDefaults(next);
  const nextKey = runtimeKey({ ...draft.form, ...defaults });
  const currentKey = runtimeKey(draft.form);
  if (nextKey === currentKey) {
    if (matchesRuntime(draft.form, next)) return draft;
    return {
      ...draft,
      form: { ...draft.form, agyNativeEnabled: defaults.agyNativeEnabled, agyAcpEnabled: defaults.agyAcpEnabled },
    };
  }
  const runtimeDrafts = { ...draft.runtimeDrafts };
  // Object insertion order records the most recently visited exact binding for each harness.
  delete runtimeDrafts[currentKey];
  runtimeDrafts[currentKey] = { ...pickRuntime(draft.form), ...(nativeHarness ? { harnessId: nativeHarness } : {}) };
  const restored =
    (next.kind === 'tool' && next.harnessId
      ? Object.values(runtimeDrafts)
          .reverse()
          .find(
            (fields) =>
              !fields.acpAgentProvider &&
              fields.harnessId === next.harnessId &&
              (!next.agyCarrier || (next.agyCarrier === 'native' ? usesAgyNative(fields) : usesAgyAcp(fields))),
          )
      : undefined) ?? runtimeDrafts[nextKey];
  // Fill every key, including optional undefined values omitted by JSON draft storage.
  const fields = restored ? pickRuntime(restored) : defaults;
  return { ...draft, runtimeDrafts, form: { ...draft.form, ...fields } };
}
