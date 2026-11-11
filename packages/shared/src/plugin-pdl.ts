import { z } from 'zod';

// E22's manifest data envelope. The copied engine owns PDL component/view semantics.
const declaration = z.record(z.unknown());
export const pluginPdlSchema = z
  .object({
    id: z.string().min(1).optional(),
    icon: z.string().optional(),
    // Nodes by id: PDL views, or independent pages (type: 'frame' with src / route / bridge / focus).
    views: z.record(declaration).optional(),
    // Nodes the plugin adds to the one tree (anchor / at / node), and templates registered by type.
    inserts: z.array(declaration).optional(),
    templates: z.array(declaration).optional(),
    popups: z.record(declaration).optional(),
    icons: z.record(z.string()).optional(),
    // Console package parts: text namespace and texts by language, row templates, plugin-relative reads, app script.
    ns: z.string().optional(),
    i18n: z.record(z.record(z.unknown())).optional(),
    rows: z.record(declaration).optional(),
    requests: z.record(declaration).optional(),
    app: z.string().optional(),
    // Served index only: revision of the subtree that is fetched on first projection.
    subtree: z.string().optional(),
  })
  .strict();
export type PluginPdlFragment = z.infer<typeof pluginPdlSchema>;
/** What registers at start: everything but view content, popups, requests and the app script. */
export interface PluginPdlResponse {
  fragments: Record<string, PluginPdlFragment>;
}
/** A plugin's subtree, fetched the first time one of its nodes is projected (E22). */
export type PluginPdlSubtree = Pick<PluginPdlFragment, 'views' | 'popups' | 'requests' | 'app'>;

// Keys of a node declaration (where it opens, its route, its page); everything else in a view is its content.
const NODE_KEYS = new Set(['type', 'route', 'src', 'bridge', 'focus', 'popup', 'panel', 'open', 'exit']);
export function pluginPdlSplit(fragment: PluginPdlFragment): { index: PluginPdlFragment; subtree: PluginPdlSubtree } {
  const { views, popups, requests, app, ...rest } = fragment;
  const index: PluginPdlFragment = views
    ? {
        ...rest,
        views: Object.fromEntries(
          Object.entries(views).map(([id, view]) => [
            id,
            Object.fromEntries(Object.entries(view).filter(([key]) => NODE_KEYS.has(key))),
          ]),
        ),
      }
    : rest;
  return { index, subtree: { views, popups, requests, app } };
}
