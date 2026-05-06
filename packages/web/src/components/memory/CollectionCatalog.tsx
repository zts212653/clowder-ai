'use client';

import React, { useCallback, useEffect, useState } from 'react';

interface CollectionItem {
  manifest: {
    id: string;
    displayName: string;
    kind: string;
    sensitivity: string;
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
  public: 'bg-green-100 text-green-800',
  internal: 'bg-blue-100 text-blue-800',
  private: 'bg-amber-100 text-amber-800',
  restricted: 'bg-red-100 text-red-800',
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

  useEffect(() => {
    fetch('/api/library/catalog')
      .then((r) => r.json())
      .then((data) => setCollections(data.collections ?? []))
      .catch(() => setCollections([]))
      .finally(() => setLoading(false));
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  if (loading) {
    return <div className="p-4 text-cafe-secondary text-sm">Loading collections...</div>;
  }

  if (collections.length === 0) {
    return <div className="p-4 text-cafe-secondary text-sm">No collections registered.</div>;
  }

  return (
    <div className="grid gap-3" data-testid="collection-catalog">
      {collections.map((c) => {
        const isExpanded = expandedId === c.manifest.id;
        return (
          <div
            key={c.manifest.id}
            className="rounded-lg border border-cafe bg-white p-4 transition-colors hover:border-cafe-primary/30"
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
                  <span className="ml-2 text-amber-600">{c.health.pendingReviewCount} pending review</span>
                )}
              </div>
            )}
            {isExpanded && <CollectionDetail collectionId={c.manifest.id} />}
          </div>
        );
      })}
    </div>
  );
}
