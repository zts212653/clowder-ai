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

export function readPluginSpaces(): Promise<PluginPdlResponse> {
  return request<PluginPdlResponse>('/api/plugin-manager/pdl');
}

/** Read one plugin's subtree when its nodes are first projected (its components load in the engine, E22). */
export function readPluginSubtree(id: string): Promise<PluginPdlSubtree> {
  return request<PluginPdlSubtree>('/api/plugin-manager/pdl/' + encodeURIComponent(id));
}
