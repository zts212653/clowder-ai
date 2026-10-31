import { randomUUID } from 'node:crypto';
import { whileNotAborted } from '../../live/host/live-controlled-context.js';
import type {
  CurrentPageRequest,
  OwnerPageActionPlan,
  OwnerPageActionProfile,
  OwnerPageHandle,
  OwnerPagePreview,
} from '../../live/host/owner-page-action-contract.js';
import { closeResources } from '../../live/host/page-action/owner-page-action-support.js';
import { createCdpPageActionPort } from '../CdpPageActionPort.js';
import { discoverOwnerCurrentPage } from './CurrentPageDiscovery.js';
import { type createJevPageSelector, JevSelectionNotice, ownerLiteralValues } from './JevPageSelector.js';
import {
  type CurrentBrowserPage,
  type CurrentPageConfig,
  listCurrentBrowserPages,
  openCurrentBrowserPage,
} from './OwnerCurrentPageBrowser.js';

export interface OwnerPageOption {
  pageId: string;
  title: string;
  url: string;
}
interface Grant {
  key: string;
  expires: number;
  options: Map<string, CurrentBrowserPage>;
  selected?: CurrentBrowserPage;
  selectedId?: string;
}
const key = (current: CurrentPageRequest) =>
  JSON.stringify([current.scope, current.request.sourceRef, current.request.revision]);

export interface PreparedCurrentPage {
  profile: OwnerPageActionProfile;
  handle: OwnerPageHandle;
  port: OwnerPagePreview['port'];
  snapshot: Awaited<ReturnType<OwnerPagePreview['port']['inspect']>>;
  plan: OwnerPageActionPlan;
}

/** Call/request-scoped owner selection. Browsing metadata does not grant a DOM read or an action. */
export function createOwnerCurrentPageSource(
  config: CurrentPageConfig,
  provider: ReturnType<typeof createJevPageSelector>,
) {
  const grants = new Map<string, Grant>();
  const currentGrant = (current: CurrentPageRequest) => {
    const grant = grants.get(current.scope.callId);
    return grant && grant.key === key(current) && grant.expires > Date.now() ? grant : undefined;
  };
  return {
    profileId: config.profileId,
    selected(current: CurrentPageRequest) {
      return currentGrant(current)?.selected;
    },
    clear(callId: string) {
      grants.delete(callId);
    },
    async list(current: CurrentPageRequest, signal: AbortSignal): Promise<OwnerPageOption[]> {
      const pages = await listCurrentBrowserPages(config, signal);
      if (signal.aborted) throw new Error('Page selection cancelled');
      const options = new Map(pages.map((page) => [randomUUID(), page]));
      grants.set(current.scope.callId, { key: key(current), expires: Date.now() + 60_000, options });
      return [...options].map(([pageId, page]) => ({ pageId, title: page.title, url: page.url }));
    },
    choose(current: CurrentPageRequest, pageId: string) {
      const grant = currentGrant(current);
      const page = grant?.options.get(pageId);
      if (!grant || !page) throw new Error('Exact current owner page selection required');
      grant.selected = Object.freeze({ ...page });
      grant.selectedId = pageId;
    },
    async prepare(
      current: CurrentPageRequest,
      signal: AbortSignal,
      selectionId?: string,
    ): Promise<PreparedCurrentPage> {
      const grant = currentGrant(current);
      const selected = grant?.selected;
      if (selectionId && grant?.selectedId !== selectionId) throw new Error('Owner page choice changed');
      if (!selected) throw new Error('Select the current page first');
      const handle = await openCurrentBrowserPage(config, selected, signal);
      let port: ReturnType<typeof createCdpPageActionPort> | undefined;
      try {
        const discovered = await whileNotAborted(signal, discoverOwnerCurrentPage(handle.page));
        if (discovered.url !== selected.url) throw new Error('Selected page navigated');
        const first = discovered.targets[0];
        if (!first) throw new Error('No current page controls');
        port = createCdpPageActionPort(handle.page, {
          currentControls: true,
          targets: discovered.targets,
          readback: { selector: first.selector, kind: 'text' },
        });
        const initial = await whileNotAborted(signal, port.inspect());
        const selection = await whileNotAborted(
          signal,
          provider.select({ utterance: current.request.text, candidates: initial.candidates, signal }),
        );
        if (selection.choice.kind !== 'act') throw new JevSelectionNotice(selection.choice, selection.receipt);
        const choice = selection.choice;
        const target = discovered.targets.find(
          (item) => item.id === choice.targetId && item.operation === choice.operation,
        );
        const original = initial.candidates.find((item) => item.id === choice.targetId);
        if (
          !target ||
          !original ||
          (choice.operation === 'fill' &&
            (choice.value === undefined || !ownerLiteralValues(current.request.text).includes(choice.value)))
        )
          throw new Error('Current target unavailable');
        const readback = {
          selector: target.selector,
          kind: target.operation === 'fill' ? ('value' as const) : ('text' as const),
        };
        port.setReadback(readback);
        const snapshot = await whileNotAborted(signal, port.inspect());
        const observed = snapshot.candidates.find((item) => item.id === target.id);
        if (
          signal.aborted ||
          snapshot.url !== selected.url ||
          observed?.fingerprint !== original.fingerprint ||
          currentGrant(current)?.selected !== selected
        )
          throw new Error('Current page or target changed during selection');
        const action = Object.freeze({
          targetId: target.id,
          operation: target.operation,
          value: choice.value,
          fingerprint: original.fingerprint,
          ...(target.operation === 'fill' ? { expectedReadback: choice.value } : {}),
        });
        const plan: OwnerPageActionPlan = {
          profileId: `current-page-${randomUUID()}`,
          url: snapshot.url,
          origin: snapshot.origin,
          beforeReadback: snapshot.readback,
          action,
          selection: selection.receipt,
          consent: { pageUrl: snapshot.url, field: observed.label, value: choice.value },
        };
        const profile: OwnerPageActionProfile = {
          profileId: plan.profileId,
          url: plan.url,
          spec: { targets: [target], readback, currentControls: true },
          restoreAfterAction: false,
          prepare() {
            throw new Error('Current page preparation is request-bound');
          },
          rollback() {
            throw new Error('A new owner request is required');
          },
          selector(offered) {
            if (offered !== action) throw new Error('Current decision unavailable');
            return {
              async select(input) {
                const liveTarget = input.candidates.find((item) => item.id === action.targetId);
                return !input.signal.aborted &&
                  input.utterance === current.request.text &&
                  liveTarget?.fingerprint === action.fingerprint
                  ? choice
                  : { kind: 'none' as const, reason: 'Current page decision expired' };
              },
            };
          },
        };
        if (!port.close) throw new Error('Current page actor must support cleanup');
        return { profile, plan, snapshot, handle, port: port as OwnerPagePreview['port'] };
      } catch (error) {
        await closeResources(handle, port?.close ? (port as OwnerPagePreview['port']) : undefined);
        throw error;
      }
    },
  };
}
export type OwnerCurrentPageSource = ReturnType<typeof createOwnerCurrentPageSource>;
