/**
 * clowder-ai#768: the client-scoped slice of the member editor, in one place.
 *
 * Two things live here because they are the same rule seen from two sides: which
 * fields a client switch invalidates, and which model a given (client, account)
 * scope resolves to. Splitting them is what produced the original defects.
 *
 * Two paths change `clientId` — the Client selector in AccountSection and role-template
 * selection in HubCatEditor — and only the first one used to normalize the client-scoped
 * fields. State left behind by the other path is not merely stale in the form: it is
 * saved. `buildAcpPatch()` reads `acpEnabled` without re-checking the client, and the
 * transport selector is hidden for single-transport clients, so a surviving ACP transport
 * is persisted with nothing on screen to reveal it. The model is the same story: auto-fill
 * only writes into an empty field, so a template-bound model rides onto the next client.
 */
import {
  defaultAcpCommandForClient,
  defaultAcpStartupArgsForClient,
  isAcpOnlyClient,
  showTransportSelector,
} from './hub-cat-editor.acp';
import type { HubCatEditorFormState } from './hub-cat-editor.model';

type ClientId = HubCatEditorFormState['clientId'];

/** Carry over ACP command/args only where the user has customized them. */
function acpDefaults(form: HubCatEditorFormState, nextClient: ClientId): Partial<HubCatEditorFormState> {
  const command = form.acpCommand.trim();
  const startupArgs = form.acpStartupArgs.trim();
  return {
    ...(!command || command === defaultAcpCommandForClient(form.clientId)
      ? { acpCommand: defaultAcpCommandForClient(nextClient) }
      : {}),
    ...(!startupArgs || startupArgs === defaultAcpStartupArgsForClient(form.clientId)
      ? { acpStartupArgs: defaultAcpStartupArgsForClient(nextClient) }
      : {}),
  };
}

/**
 * The patch that moves the form to `nextClient`. Callers apply it only on an actual
 * switch; a template may then override `defaultModel` with its own recommendation.
 */
export function clientSwitchPatch(form: HubCatEditorFormState, nextClient: ClientId): Partial<HubCatEditorFormState> {
  const acpEnabled = isAcpOnlyClient(nextClient) || (showTransportSelector(nextClient) && form.acpEnabled);
  return {
    clientId: nextClient,
    provider: '',
    cliEffort: '',
    codexCarrier: '',
    defaultModel: '',
    acpEnabled,
    ...(acpEnabled ? acpDefaults(form, nextClient) : {}),
  };
}

/**
 * The model a (client, account) scope resolves to, or `null` to keep what is there.
 *
 * Precedence, in one place so the editor cannot honour it differently per path:
 *
 * 1. The selected account's own model list wins. A template default that the account
 *    does not serve is not merely cosmetic — an API-key account leaves `provider`
 *    empty, so a bare foreign model id fails save validation and the member the
 *    template just created cannot be saved at all.
 * 2. Otherwise the template's `clientDefaults` entry for the client, which is what
 *    keeps a client whose accounts expose no model list (Antigravity, API-key
 *    accounts without a catalog) from saving a model-less member.
 * 3. A value already in the field is respected while the scope is unchanged, so
 *    typing a model the catalog does not list still works. Changing client or
 *    account is what invalidates it — the same rule `clientSwitchPatch` applies.
 */
export function resolveScopedDefaultModel(args: {
  readonly currentModel: string;
  readonly accountModels: readonly string[];
  readonly templateDefaultModel: string | undefined;
  readonly scopeChanged: boolean;
}): string | null {
  const next = args.accountModels[0] ?? args.templateDefaultModel ?? '';
  if (!next) return null;
  if (args.currentModel.trim().length > 0 && !args.scopeChanged) return null;
  if (next === args.currentModel) return null;
  return next;
}

/** Identity of the scope a resolved model belongs to. */
export function modelScopeKey(clientId: string, accountRef: string): string {
  return `${clientId}::${accountRef}`;
}
