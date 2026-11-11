import type { PluginPdlResponse, PluginPdlSubtree } from '@cat-cafe/shared';
import { request } from './owner-api';

export function callPluginOperation(id: string, operation: string, action: string, body: unknown, confirmed: boolean) {
  return request(
    '/api/plugins/' +
      encodeURIComponent(id) +
      '/actions/' +
      encodeURIComponent(operation) +
      '/' +
      encodeURIComponent(action),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(confirmed ? { 'x-cat-cafe-owner-confirmed': 'true' } : {}) },
      body: JSON.stringify(body),
    },
  );
}

const appsRun = new Map<string, string>();

/** Read the admitted plugins' indexes: what registers at start (inserts, templates, rows, texts, node declarations). */
export function readPluginSpaces(): Promise<PluginPdlResponse> {
  return request<PluginPdlResponse>('/api/plugin-manager/pdl');
}

/**
 * Read one plugin's subtree when its nodes are first projected; run its console app script once. A script cannot be
 * taken back, so an updated plugin whose script changed reloads the page (declarations re-register in place).
 */
export async function readPluginSubtree(id: string): Promise<PluginPdlSubtree> {
  const { app, ...subtree } = await request<PluginPdlSubtree>('/api/plugin-manager/pdl/' + encodeURIComponent(id));
  if (app === undefined || appsRun.get(id) === app) return subtree;
  if (appsRun.has(id)) {
    window.location.reload();
    return subtree;
  }
  appsRun.set(id, app);
  const script = document.createElement('script');
  script.text = app;
  document.body.append(script);
  return subtree;
}
