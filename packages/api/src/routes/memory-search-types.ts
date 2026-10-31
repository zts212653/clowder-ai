import type { CollectionManifest, IEvidenceStore, SearchOptions } from '../domains/memory/interfaces.js';
import type { MessageSearchService } from '../domains/memory/MessageSearchService.js';
import type { TasteRepository } from '../domains/taste/services/TasteRepository.js';

export type MemorySearchType = 'memory' | 'documents' | 'conversations';
export interface MemorySearchQuery {
  q: string;
  type: MemorySearchType | 'all';
  depth: 'summary' | 'raw';
  limit: number;
}
export interface MemorySearchSources {
  tasteRepository?: TasteRepository;
  messageSearchService?: Pick<MessageSearchService, 'search'>;
}
export interface MemorySearchOptions extends MemorySearchSources {
  ownerUserId: string;
  catalog: { list(): CollectionManifest[] };
  stores: ReadonlyMap<string, IEvidenceStore>;
}
export interface MemorySearchResult {
  id: string;
  title: string;
  snippet: string;
  displayType: string;
  authority: string | null;
  updatedAt: string | number | null;
  destination:
    | { kind: 'taste'; id: string; revision: string }
    | { kind: 'document'; collection: string; anchor: string }
    | { kind: 'message'; threadId: string; messageId: string; contentRevision: string }
    | null;
  graph: { anchor: string; collection: string } | null;
}
export interface MemorySearchGroup {
  type: MemorySearchType;
  status: 'ready' | 'partial' | 'unavailable';
  results: MemorySearchResult[];
  hasMore: boolean;
  degraded?: boolean;
}
export type SearchExecution = Pick<SearchOptions, 'signal' | 'deadlineAt'>;
export function checkMemorySearchExecution(execution: SearchExecution) {
  execution.signal?.throwIfAborted();
  if (execution.deadlineAt !== undefined && Date.now() >= execution.deadlineAt)
    throw new DOMException('Search deadline exceeded', 'TimeoutError');
}

export const isMemoryIndexPath = (path: string) => /(?:^|\/)(?:private\/taste|taste\/vignettes)(?:\/|$)/.test(path);
