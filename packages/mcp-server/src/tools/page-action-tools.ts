import { defineMcpCanonicalFactory } from '../tool-governance-migration.js';
import { callbackPost } from './callback-tools.js';

const define = defineMcpCanonicalFactory('page-action-tools.ts', undefined, {
  resourceFamily: 'owner-page-action',
  authority: 'callback-owner-private',
});
export const handlePageActionInspect = async () =>
  callbackPost(
    '/api/callbacks/page-action-inspect',
    {},
    { fetchTimeoutMs: 10_000, enableOutbox: false, retryDelaysMs: [] },
  );
export const handlePageActionStatus = async () => callbackPost('/api/callbacks/page-action-status', {});

export const pageActionTools = [
  define({
    name: 'cat_cafe_page_action_inspect',
    inputSchema: {},
    handler: handlePageActionInspect,
    description:
      'Ask real Jev to select an action from the current Host-configured page for the current direct owner Live request. Only available to the bound owner Live invocation. Sends bounded request text and current permitted target labels to TypeSafe; no whole page or screenshot. Returns selected target/model receipt and awaits owner UI consent, or ask/none/unavailable. Never claims an effect or grants execution. No URL, selector, value or request source is accepted from the model. Missing configuration/provider fails truthfully; no fallback model.',
    governance: {
      implementationExport: 'handlePageActionInspect',
      action: 'derive',
      risk: { level: 'write', openWorld: true },
      runtimeProfiles: ['full', 'desktop:live-companion'],
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'resource-entry',
        admissionRef: 'architecture-cell:owner-page-action',
      },
    },
  }),
  define({
    name: 'cat_cafe_page_action_status',
    inputSchema: {},
    handler: handlePageActionStatus,
    description:
      'Read the current owner Live page-action request, Jev selection/clarification, consent and actual Driver readback. Same bound invocation required. Say applied only for verified applied; awaiting_consent means no write, unknown means unconfirmed and must not be retried automatically. A new request invalidates old selection. This tool cannot confirm, cancel, navigate or execute a page action.',
    governance: {
      implementationExport: 'handlePageActionStatus',
      action: 'read',
      risk: { level: 'read', openWorld: false },
      runtimeProfiles: ['full', 'desktop:live-companion'],
      standaloneReason: {
        disposition: 'accepted-boundary',
        kind: 'resource-entry',
        admissionRef: 'architecture-cell:owner-page-action',
      },
    },
  }),
] as const;
