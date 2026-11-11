'use client';

export interface GraphQueryCandidate {
  anchor: string;
  title: string;
  kind: string;
  collectionId: string;
  source?: string;
  matchReason: 'anchor' | 'title' | 'source' | 'summary' | 'keyword' | 'content';
  snippet?: string;
  edgeCount?: number;
}
