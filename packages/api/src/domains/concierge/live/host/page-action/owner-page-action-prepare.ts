import { createCdpPageActionPort } from '../../../action/CdpPageActionPort.js';
import type { PreparedCurrentPage } from '../../../action/jev/OwnerCurrentPageSource.js';
import { whileNotAborted } from '../live-controlled-context.js';
import type { CurrentPageRequest, OwnerPageActionDeps, OwnerPagePreview } from '../owner-page-action-contract.js';
import { closeResources } from './owner-page-action-support.js';

export async function prepareOwnerPageAction(
  deps: OwnerPageActionDeps,
  current: CurrentPageRequest,
  signal: AbortSignal,
  selectionId?: string,
): Promise<PreparedCurrentPage> {
  if (deps.currentPages) {
    const preparing = deps.currentPages.prepare(current, signal, selectionId);
    try {
      return await whileNotAborted(signal, preparing);
    } catch (error) {
      void preparing.then((late) => closeResources(late.handle, late.port)).catch(() => {});
      throw error;
    }
  }
  const profile = deps.profile;
  if (!profile || !deps.connector) throw new Error('Page action unavailable');
  const opening = deps.connector.open(profile, signal);
  let handle: OwnerPagePreview['handle'] | undefined;
  let port: OwnerPagePreview['port'] | undefined;
  try {
    handle = await whileNotAborted(signal, opening);
    const created = createCdpPageActionPort(handle.page, profile.spec);
    if (!created.close) throw new Error('Page actor cannot be closed');
    port = created as OwnerPagePreview['port'];
    const snapshot = await whileNotAborted(signal, port.inspect());
    const plan = await whileNotAborted(
      signal,
      Promise.resolve(profile.prepare(snapshot, { utterance: current.request.text, signal })),
    );
    return { profile, handle, port, snapshot, plan };
  } catch (error) {
    if (handle) await closeResources(handle, port);
    else void opening.then((late) => closeResources(late)).catch(() => {});
    throw error;
  }
}
