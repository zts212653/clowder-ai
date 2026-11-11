'use client';

export interface LibraryCollection {
  id: string;
  name: string;
  kind: string;
  visibility: string;
  status: string;
  readStatus: 'ready' | 'unavailable';
  docCount: number | null;
  lastDocumentUpdatedAt: string | null;
}
export interface LibraryCandidate {
  id: string;
  content: string;
  kind: string;
  createdAt: string;
  collectionName: string | null;
  state: string;
  sourceCollectionId?: string | null;
  sourceVisibility?: string | null;
}
