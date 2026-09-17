/**
 * clowder-ai#768: everything a client switch invalidates, in one place.
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
