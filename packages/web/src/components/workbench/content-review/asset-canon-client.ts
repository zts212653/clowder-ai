import type { AssetCanonItem, AssetCanonUpdate, WorkReference } from '@cat-cafe/shared';
import { checked, json } from '@/components/content-review/modification-http';
import { API_URL, apiFetch } from '@/utils/api-client';

export function canonCommand<T>(threadId: string, command: unknown, signal?: AbortSignal): Promise<T> {
  return apiFetch('/api/works/command', { ...json({ threadId, command }), signal }).then(checked<T>);
}
export function canonAssetUrl(item: AssetCanonItem, threadId: string) {
  return `${API_URL}/api/asset-canon/${encodeURIComponent(item.record.indexedVersionRef)}/bytes?${new URLSearchParams({ threadId, purpose: 'used' })}`;
}
export interface CanonPage {
  items: AssetCanonItem[];
  updates?: AssetCanonUpdate[];
  kept?: AssetCanonUpdate[];
  snapshot: string;
  nextAfter?: number;
}
export async function readCanonPages(
  threadId: string,
  reference: WorkReference,
  metadataRevision: number,
  signal: AbortSignal,
  onPage: (page: CanonPage) => void,
) {
  let after: number | undefined = 0;
  let snapshot: string | undefined;
  do {
    const page: CanonPage = await canonCommand(
      threadId,
      {
        action: 'list-assets',
        purpose: 'used',
        reference,
        metadataRevision,
        verifyFiles: false,
        limit: 50,
        after,
        ...(snapshot ? { snapshot } : {}),
      },
      signal,
    );
    onPage(page);
    snapshot = page.snapshot;
    after = page.nextAfter;
  } while (after !== undefined && !signal.aborted);
}
