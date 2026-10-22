import { serializeCommandArgs } from '../../hub-cat-editor.acp';
import { type HubCatEditorFormState, initialState, splitCommandArgs } from '../../hub-cat-editor.model';
import { resolveDraftCarrier } from './member-carrier-compat';
import type { MemberDraft } from './member-editor-state';
import type { NativeLoginState } from './native-login-state';

export interface RuntimeChoice {
  id: string;
  label: string;
  clientId: HubCatEditorFormState['clientId'];
  installed: boolean;
  readiness?: NativeLoginState;
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
export type RuntimeDrafts = Record<string, RuntimeFields>;

function runtimeKey(form: RuntimeFields): string {
  return JSON.stringify([
    form.clientId,
    resolveDraftCarrier(form) === 'acp'
      ? [form.acpAgentProvider ?? '', form.acpCommand, splitCommandArgs(form.acpStartupArgs), form.acpTransport]
      : null,
  ]);
}

export function matchesRuntime(form: RuntimeFields, choice: RuntimeChoice): boolean {
  return runtimeKey(form) === runtimeKey(runtimeDefaults(choice));
}

/** Keep undiscovered/custom tools selectable while the user compares tools in this draft. */
export function rememberedRuntimes(drafts: RuntimeDrafts = {}): RuntimeChoice[] {
  return Object.entries(drafts).map(([key, form]) => ({
    id: `draft:${key}`,
    label: resolveDraftCarrier(form) === 'acp' ? form.acpCommand : form.clientId,
    clientId: form.clientId,
    installed: false,
    models: [],
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
  };
}

function pickRuntime(form: RuntimeFields): RuntimeFields {
  return {
    ...Object.fromEntries(runtimeFields.map((key) => [key, form[key]])),
    carrier: resolveDraftCarrier(form),
  } as RuntimeFields;
}

/** Switching changes only the draft. Returning to a tool restores its exact binding and overrides. */
export function switchMemberRuntime(draft: MemberDraft, next: RuntimeChoice): MemberDraft {
  const defaults = runtimeDefaults(next);
  const nextKey = runtimeKey({ ...draft.form, ...defaults });
  const currentKey = runtimeKey(draft.form);
  if (nextKey === currentKey) return draft;
  const runtimeDrafts = { ...draft.runtimeDrafts, [currentKey]: pickRuntime(draft.form) };
  const restored = runtimeDrafts[nextKey];
  // Fill every key, including optional undefined values omitted by JSON draft storage.
  const fields = restored ? pickRuntime(restored) : defaults;
  return { ...draft, runtimeDrafts, form: { ...draft.form, ...fields } };
}
