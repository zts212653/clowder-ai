import { statSync } from 'node:fs';
import type { F163Authority } from './f163-types.js';

export const COLLECTION_KINDS = ['project', 'world', 'domain', 'research', 'global'] as const;
export type CollectionKind = (typeof COLLECTION_KINDS)[number];

export type CollectionSensitivity = 'public' | 'internal' | 'private' | 'restricted';

export const COLLECTION_SENSITIVITY_ORDER: Record<CollectionSensitivity, number> = {
  restricted: 0,
  private: 1,
  internal: 2,
  public: 3,
};

export const REVIEW_STATUSES = ['unreviewed', 'partial', 'reviewed', 'stale'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export interface CollectionManifest {
  id: string;
  kind: CollectionKind;
  name: string;
  displayName: string;
  root: string;
  sensitivity: CollectionSensitivity;
  scannerLevel: 0 | 1 | 2 | 3 | 'auto';
  indexPolicy: {
    autoRebuild: boolean;
    rebuildIntervalMs?: number;
  };
  reviewPolicy: {
    authorityCeiling: F163Authority;
    requireOwnerApproval: boolean;
  };
  exclude?: string[];
  createdAt: string;
  updatedAt: string;
}

const COLLECTION_ID_RE = /^[a-z]+:[a-z][a-z0-9-]*$/;

export function validateCollectionId(id: string): void {
  if (!COLLECTION_ID_RE.test(id)) {
    throw new Error(`Invalid collection id format: "${id}" — must be <kind>:<lowercase-name>`);
  }
}

const VALID_KINDS = new Set<string>(COLLECTION_KINDS);
const VALID_SENSITIVITIES = new Set<string>(['public', 'internal', 'private', 'restricted']);
const VALID_SCANNER_LEVELS = new Set<number | string>([0, 1, 2, 3, 'auto']);

export function validateManifestInput(input: {
  id: string;
  kind: string;
  sensitivity?: string;
  scannerLevel?: number | string;
  root: string;
}): void {
  validateCollectionId(input.id);

  if (!VALID_KINDS.has(input.kind)) {
    throw new Error(`Invalid kind: "${input.kind}" — must be one of: ${COLLECTION_KINDS.join(', ')}`);
  }

  const idKind = input.id.split(':')[0];
  if (idKind !== input.kind) {
    throw new Error(`ID kind prefix "${idKind}" does not match kind "${input.kind}"`);
  }

  if (input.sensitivity !== undefined && !VALID_SENSITIVITIES.has(input.sensitivity)) {
    throw new Error(
      `Invalid sensitivity: "${input.sensitivity}" — must be one of: public, internal, private, restricted`,
    );
  }

  if (input.scannerLevel !== undefined && !VALID_SCANNER_LEVELS.has(input.scannerLevel)) {
    throw new Error(`Invalid scannerLevel: ${input.scannerLevel} — must be one of: 0, 1, 2, 3, auto`);
  }

  const stat = statSync(input.root, { throwIfNoEntry: false });
  if (!stat) {
    throw new Error(`Root path does not exist: ${input.root}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`Root path is not a directory: ${input.root}`);
  }
}

export const SEARCH_DIMENSIONS = ['project', 'global', 'all', 'library', 'collection'] as const;
export type SearchDimension = (typeof SEARCH_DIMENSIONS)[number];

export const ILibraryCatalogSymbol = Symbol.for('ILibraryCatalog');
