import { normalizeToolExecutionPolicy } from '../../../cats/services/agents/invocation/tool-execution-policy.js';
import { WATCHER_TOOL_ROUTES } from '../../../cats/services/agents/invocation/WatcherToolTicket.js';
import type { ToolExecutionPolicy } from '../../../cats/services/types.js';

/** Named surface and its callback dependencies, shared by every ordinary watcher carrier. */
export const WATCHER_PANEL_TOOL_ROUTES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  ...WATCHER_TOOL_ROUTES,
  cat_cafe_search_evidence: ['GET /api/callbacks/search-evidence', 'GET /api/callbacks/memory-matters'],
  cat_cafe_read_file_slice: [], // Local reader: no file-write or command entry exists in this surface.
  cat_cafe_list_threads: ['GET /api/callbacks/list-threads'],
  cat_cafe_get_thread_cats: ['GET /api/callbacks/thread-cats'],
  cat_cafe_get_thread_metadata: ['GET /api/callbacks/thread-metadata'],
  cat_cafe_list_tasks: ['GET /api/callbacks/list-tasks'],
  cat_cafe_feat_index: ['GET /api/callbacks/feat-index'],
  cat_cafe_get_workflow_sop: ['GET /api/callbacks/get-workflow-sop'],
  cat_cafe_get_rich_block_rules: ['GET /api/callbacks/rich-block-rules'],
});

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
  return normalizeToolExecutionPolicy({
    mode: 'watcher_panel',
    allowedCallbackRoutes: WATCHER_PANEL_CALLBACK_ROUTES,
    allowedToolNames: Object.keys(WATCHER_PANEL_TOOL_ROUTES),
  });
}
