import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import { callbackPost } from './callback-tools.js';

const define = defineMcpCanonicalFactory('home-action-tools.ts', undefined, {
  resourceFamily: 'hub-action-surface',
  authority: 'callback-owner-private',
});
export const handleHomeAction = () =>
  callbackPost(
    '/api/callbacks/home-action',
    {},
    {
      fetchTimeoutMs: 20_000,
      enableOutbox: false,
      retryDelaysMs: [],
    },
  );
export const homeActionTools = [
  define({
    name: 'cat_cafe_home_action',
    inputSchema: {},
    handler: handleHomeAction,
    description:
      'Use real Jev to choose a first-party Café action for the latest direct owner request in this Live call: open an original partner publication/version already readable by this cat (Host re-reads the source and verifies the displayed version), navigate to a real visible conversation or Settings section, or append the owner’s exact words to the current composer while preserving its draft and attachments and never sending. Host supplies all targets, current source and owner authority. No URL, selector, source, target or value may be supplied by the model. Returns the actual Hub/owner receipt and served Jev model. Applied means verified execution; blocked/unconfirmed/stale/unavailable are not success and must not be retried automatically. Ask requires clarification. This does not grant sending, deleting, installing or external webpage actions.',
    governance: {
      implementationExport: 'handleHomeAction',
      action: 'apply',
      risk: { level: 'write', openWorld: true },
      runtimeProfiles: ['full', 'desktop:live-companion'],
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'resource-entry',
        admissionRef: 'file:docs/architecture/f317-home-action-admission.md',
      },
    },
  }),
] as const;
