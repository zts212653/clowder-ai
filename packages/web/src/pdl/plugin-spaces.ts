import type { PluginPdlResponse, PluginPdlSubtree } from '@cat-cafe/shared';
import { mutationRequestOptions } from '@/components/settings/plugin-manager/plugin-manager-mutation-options';
import { request } from './owner-api';

export function callPluginOperation(id: string, operation: string, action: string, body: unknown, confirmed: boolean) {
  const path =
    '/api/plugins/' +
    encodeURIComponent(id) +
    '/actions/' +
    encodeURIComponent(operation) +
    '/' +
    encodeURIComponent(action);
  return request(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(confirmed ? { 'x-cat-cafe-owner-confirmed': 'true' } : {}) },
      body: JSON.stringify(body),
    },
    mutationRequestOptions(path),
  );
}

export function readPluginSpaces(): Promise<PluginPdlResponse> {
  return request<PluginPdlResponse>('/api/plugin-manager/pdl');
}

/** Read one plugin's subtree when its nodes are first projected (its components load in the engine, E22). */
export function readPluginSubtree(id: string): Promise<PluginPdlSubtree> {
  return request<PluginPdlSubtree>('/api/plugin-manager/pdl/' + encodeURIComponent(id));
}
