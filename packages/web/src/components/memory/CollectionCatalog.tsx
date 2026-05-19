'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { CreateCollectionDialog } from './CreateCollectionDialog';

interface CollectionItem {
  manifest: {
    id: string;
    displayName: string;
    kind: string;
    sensitivity: string;
    status?: string;
  };
  overview: {
    docCount: number;
    topKinds: Array<{ kind: string; count: number }>;
    recentAnchors: Array<{ anchor: string; title: string; updatedAt: string }>;
  } | null;
  health: {
    indexFreshness: string;
    pendingReviewCount: number;
  } | null;
}

interface DocumentGroup {
  kind: string;
  count: number;
  hasMore: boolean;
  documents: Array<{ anchor: string; title: string; updatedAt: string; status: string }>;
}

const SENSITIVITY_BADGE: Record<string, string> = {
  public: 'bg-conn-green-bg text-green-800',
  internal: 'bg-blue-100 text-conn-blue-text',
  private: 'bg-conn-amber-bg text-conn-amber-text',
  restricted: 'bg-conn-red-bg text-red-800',
};

const STATUS_BADGE: Record<string, string> = {
  registered: 'bg-gray-100 text-gray-600',
  indexing: 'bg-blue-50 text-blue-600',
  active: 'bg-conn-green-bg text-green-700',
  stale: 'bg-conn-amber-bg text-conn-amber-text',
  blocked: 'bg-conn-red-bg text-red-700',
  archived: 'bg-gray-200 text-gray-500',
};

function CollectionDetail({ collectionId }: { collectionId: string }) {
  const [groups, setGroups] = useState<DocumentGroup[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/library/${encodeURIComponent(collectionId)}/documents`)
      .then((r) => r.json())
      .then((data) => setGroups(data.groups ?? []))
      .catch(() => setGroups([]))
      .finally(() => setLoading(false));
  }, [collectionId]);

  if (loading) {
    return <div className="text-xs text-cafe-secondary py-2">Loading documents...</div>;
  }

  if (groups.length === 0) {
    return <div className="text-xs text-cafe-secondary py-2">No documents indexed.</div>;
  }

  return (
    <div className="mt-3 space-y-3" data-testid={`collection-detail-${collectionId}`}>
      {groups.map((g) => (
        <div key={g.kind}>
          <div className="flex items-center gap-1.5 mb-1">
            <span className="text-xs font-medium text-cafe-primary capitalize">{g.kind}</span>
            <span className="text-[10px] text-cafe-secondary">({g.count})</span>
          </div>
          <ul className="space-y-0.5 pl-3">
            {g.documents.map((doc) => (
              <li key={doc.anchor} className="text-xs text-cafe-secondary flex items-baseline gap-1.5">
                <span className="truncate" title={doc.anchor}>
                  {doc.title || doc.anchor}
                </span>
                {doc.updatedAt && (
                  <span className="text-[10px] text-cafe-tertiary shrink-0">{doc.updatedAt.slice(0, 10)}</span>
                )}
              </li>
            ))}
            {g.hasMore && (
              <li className="text-[10px] text-cafe-tertiary italic">and {g.count - g.documents.length} more...</li>
            )}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function CollectionCatalog() {
  const [collections, setCollections] = useState<CollectionItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const loadCatalog = useCallback(() => {
    fetch('/api/library/catalog')
      .then((r) => r.json())
      .then((data) => setCollections(data.collections ?? []))
      .catch(() => setCollections([]))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    loadCatalog();
  }, [loadCatalog]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  const handleArchive = useCallback(
    async (id: string) => {
      setActionLoading(id);
      try {
        await fetch(`/api/library/${encodeURIComponent(id)}/archive`, { method: 'POST' });
        loadCatalog();
      } finally {
        setActionLoading(null);
      }
    },
    [loadCatalog],
  );

  const handleUnarchive = useCallback(
    async (id: string) => {
      setActionLoading(id);
      try {
        await fetch(`/api/library/${encodeURIComponent(id)}/unarchive`, { method: 'POST' });
        loadCatalog();
      } finally {
        setActionLoading(null);
      }
    },
    [loadCatalog],
  );

  const handleRebuild = useCallback(
    async (id: string) => {
      setActionLoading(id);
      try {
        await fetch(`/api/library/${encodeURIComponent(id)}/rebuild`, { method: 'POST' });
        loadCatalog();
      } finally {
        setActionLoading(null);
      }
    },
    [loadCatalog],
  );

  if (loading) {
    return <div className="p-4 text-cafe-secondary text-sm">Loading collections...</div>;
  }

  return (
    <div data-testid="collection-catalog">
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs text-cafe-secondary">
          {collections.length} collection{collections.length !== 1 ? 's' : ''}
        </span>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="px-3 py-1 text-xs text-white bg-cafe-primary rounded hover:bg-cafe-primary/90"
          data-testid="create-collection-btn"
        >
          + New Collection
        </button>
      </div>
      {showCreate && (
        <CreateCollectionDialog
          onClose={() => setShowCreate(false)}
          onCreated={() => {
            setShowCreate(false);
            loadCatalog();
          }}
        />
      )}
      {collections.length === 0 && <div className="p-4 text-cafe-secondary text-sm">No collections registered.</div>}
      <div className="grid gap-3">
        {collections.map((c) => {
          const isExpanded = expandedId === c.manifest.id;
          const status = c.manifest.status ?? 'active';
          const isArchived = status === 'archived';
          const isBusy = actionLoading === c.manifest.id;
          return (
            <div
              key={c.manifest.id}
              className={`rounded-lg border border-cafe bg-white p-4 transition-colors hover:border-cafe-primary/30 ${isArchived ? 'opacity-60' : ''}`}
              data-testid={`collection-card-${c.manifest.id}`}
            >
              <button
                type="button"
                className="flex items-center gap-2 mb-2 w-full text-left cursor-pointer"
                aria-expanded={isExpanded}
                onClick={() => toggleExpand(c.manifest.id)}
              >
                <span className="text-xs select-none">{isExpanded ? '▼' : '▶'}</span>
                {(c.manifest.sensitivity === 'private' || c.manifest.sensitivity === 'restricted') && (
                  <span className="text-xs select-none" title={`${c.manifest.sensitivity} collection`}>
                    🔒
                  </span>
                )}
                <span className="font-semibold text-sm text-cafe-primary">{c.manifest.displayName}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${SENSITIVITY_BADGE[c.manifest.sensitivity] ?? ''}`}
                >
                  {c.manifest.sensitivity}
                </span>
                <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${STATUS_BADGE[status] ?? ''}`}>
                  {status}
                </span>
                <span className="text-[10px] text-cafe-secondary">{c.manifest.kind}</span>
              </button>
              {c.overview && (
                <div className="text-xs text-cafe-secondary">
                  <span>{c.overview.docCount} docs</span>
                  {c.overview.topKinds.length > 0 && (
                    <span className="ml-2">
                      Top:{' '}
                      {c.overview.topKinds
                        .slice(0, 3)
                        .map((k) => `${k.kind}(${k.count})`)
                        .join(', ')}
                    </span>
                  )}
                </div>
              )}
              {c.health && (
                <div className="text-xs text-cafe-secondary mt-1">
                  <span>Last indexed: {c.health.indexFreshness || 'never'}</span>
                  {c.health.pendingReviewCount > 0 && (
                    <span className="ml-2 text-conn-amber-text">{c.health.pendingReviewCount} pending review</span>
                  )}
                </div>
              )}
              <div className="mt-2 flex gap-2">
                {isArchived ? (
                  <button
                    type="button"
                    onClick={() => handleUnarchive(c.manifest.id)}
                    disabled={isBusy}
                    className="px-2 py-0.5 text-[10px] border border-cafe rounded hover:bg-gray-50 text-cafe-secondary disabled:opacity-50"
                    data-testid={`unarchive-${c.manifest.id}`}
                  >
                    {isBusy ? '...' : 'Unarchive'}
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => handleRebuild(c.manifest.id)}
                      disabled={isBusy}
                      className="px-2 py-0.5 text-[10px] border border-cafe rounded hover:bg-gray-50 text-cafe-secondary disabled:opacity-50"
                      data-testid={`rebuild-${c.manifest.id}`}
                    >
                      {isBusy ? '...' : 'Rebuild Index'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleArchive(c.manifest.id)}
                      disabled={isBusy}
                      className="px-2 py-0.5 text-[10px] border border-cafe rounded hover:bg-gray-50 text-cafe-secondary disabled:opacity-50"
                      data-testid={`archive-${c.manifest.id}`}
                    >
                      {isBusy ? '...' : 'Archive'}
                    </button>
                  </>
                )}
              </div>
              {isExpanded && <CollectionDetail collectionId={c.manifest.id} />}
            </div>
          );
        })}
      </div>
    </div>
  );
}
