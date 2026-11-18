import { normalizeToolExecutionPolicy } from '../../../cats/services/agents/invocation/tool-execution-policy.js';
import type { ToolExecutionPolicy } from '../../../cats/services/types.js';

/**
 * F335 panel watcher callback surface, enforced by the callback auth hook per route template.
 * It reads like an ordinary member (thread history, messages, memory, tasks, feature index), files
 * memory through the existing approval lanes, and acts only through the watcher's own outlets: a
 * sentence the panel holds and delivers anonymously, and owner-facing proposals, which the
 * suggestion owner admits only while the round may speak. Posting into a thread, routing a cat,
 * holding a ball or changing work state is absent and therefore denied.
 */
export const WATCHER_PANEL_CALLBACK_ROUTES = Object.freeze([
  'GET /api/callbacks/auth-probe',
  'GET /api/callbacks/instructions',
  'GET /api/callbacks/thread-context',
  'GET /api/callbacks/get-message',
  'GET /api/callbacks/list-threads',
  'GET /api/callbacks/thread-cats',
  'GET /api/callbacks/thread-metadata',
  'GET /api/callbacks/list-labels',
  'GET /api/callbacks/search-evidence',
  'GET /api/callbacks/memory-matters',
  'GET /api/callbacks/memory-matters/:matterId',
  'GET /api/callbacks/profile',
  'GET /api/callbacks/list-tasks',
  'GET /api/callbacks/feat-index',
  'GET /api/callbacks/get-workflow-sop',
  'GET /api/callbacks/rich-block-rules',
  'GET /api/callbacks/custody-events',
  'GET /api/callbacks/hold-ball/current',
  'GET /api/callbacks/get-recall-metrics',
  'POST /api/callbacks/person-memory/recall',
  'POST /api/callbacks/person-memory/drill',
  'POST /api/callbacks/read-entrusted-work',
  'POST /api/callbacks/remember',
  'POST /api/callbacks/propose-profile-update',
  'POST /api/callbacks/propose-taste',
  'POST /api/callbacks/memory-matters/write',
  'POST /api/callbacks/watcher-nudge',
  'POST /api/callbacks/suggestions',
  'POST /api/callbacks/suggestion-receipts',
  'POST /api/callbacks/suggestion-facts',
  'POST /api/callbacks/desk-deliveries',
]);

export function watcherPanelToolPolicy(): ToolExecutionPolicy {
  return normalizeToolExecutionPolicy({ mode: 'watcher_panel', allowedCallbackRoutes: WATCHER_PANEL_CALLBACK_ROUTES });
}
