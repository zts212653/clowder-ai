import {
  COLLECTION_SENSITIVITY_ORDER,
  type CollectionManifest,
  type CollectionSensitivity,
  type CollectionStatus,
  validateCollectionId,
} from './collection-types.js';

export interface SensitivityChange {
  direction: 'widening' | 'narrowing' | 'none';
  from: CollectionSensitivity;
  to: CollectionSensitivity;
}

export class LibraryCatalog {
  private readonly collections = new Map<string, CollectionManifest>();
  private readonly aliases = new Map<string, string>();

  register(manifest: CollectionManifest): void {
    validateCollectionId(manifest.id);
    if (this.collections.has(manifest.id)) {
      throw new Error(`Collection "${manifest.id}" already registered`);
    }
    this.collections.set(manifest.id, { ...manifest });
  }

  get(id: string): CollectionManifest | undefined {
    let resolved = id;
    for (let i = 0; i < 10; i++) {
      const manifest = this.collections.get(resolved);
      if (manifest) return manifest;
      const alias = this.aliases.get(resolved);
      if (!alias) return undefined;
      resolved = alias;
    }
    return undefined;
  }

  list(): CollectionManifest[] {
    return [...this.collections.values()];
  }

  unbind(id: string): CollectionManifest {
    const manifest = this.collections.get(id);
    if (!manifest) throw new Error(`Collection "${id}" not found`);
    this.collections.delete(id);
    return manifest;
  }

  rename(oldId: string, newId: string): void {
    validateCollectionId(newId);
    const manifest = this.collections.get(oldId);
    if (!manifest) throw new Error(`Collection "${oldId}" not found`);
    if (this.collections.has(newId)) throw new Error(`Collection "${newId}" already exists`);
    this.collections.delete(oldId);
    this.collections.set(newId, { ...manifest, id: newId, updatedAt: new Date().toISOString() });
    this.aliases.set(oldId, newId);
  }

  resolveAlias(id: string): string | undefined {
    return this.aliases.get(id);
  }

  updateSensitivity(id: string, newSensitivity: CollectionSensitivity): SensitivityChange {
    const manifest = this.collections.get(id);
    if (!manifest) throw new Error(`Collection "${id}" not found`);
    const from = manifest.sensitivity;
    const direction =
      COLLECTION_SENSITIVITY_ORDER[newSensitivity] > COLLECTION_SENSITIVITY_ORDER[from]
        ? 'widening'
        : COLLECTION_SENSITIVITY_ORDER[newSensitivity] < COLLECTION_SENSITIVITY_ORDER[from]
          ? 'narrowing'
          : 'none';
    manifest.sensitivity = newSensitivity;
    manifest.updatedAt = new Date().toISOString();
    return { direction, from, to: newSensitivity };
  }

  private static readonly VALID_TRANSITIONS: Record<CollectionStatus, CollectionStatus[]> = {
    registered: ['indexing', 'archived'],
    indexing: ['active', 'blocked'],
    active: ['stale', 'archived', 'indexing'],
    stale: ['indexing', 'archived'],
    blocked: ['registered', 'archived', 'indexing'],
    archived: ['registered'],
  };

  setStatus(id: string, newStatus: CollectionStatus): void {
    const manifest = this.collections.get(id);
    if (!manifest) throw new Error(`Collection "${id}" not found`);
    const currentStatus = manifest.status ?? 'active';
    const allowed = LibraryCatalog.VALID_TRANSITIONS[currentStatus];
    if (!allowed?.includes(newStatus)) throw new Error(`Invalid transition: ${currentStatus} → ${newStatus}`);
    manifest.status = newStatus;
    manifest.updatedAt = new Date().toISOString();
  }

  archive(id: string): CollectionManifest {
    this.setStatus(id, 'archived');
    return { ...this.collections.get(id)! };
  }

  unarchive(id: string): void {
    this.setStatus(id, 'registered');
  }

  private isRoutable(m: CollectionManifest): boolean {
    return m.status !== 'archived';
  }

  getRoutable(
    dimension: 'library' | 'collection' | 'project' | 'global' | 'all',
    explicitCollections?: string[],
  ): CollectionManifest[] {
    if (dimension === 'collection') {
      if (!explicitCollections?.length) return [];
      const resolved = [...new Set(explicitCollections)]
        .map((id) => this.get(id))
        .filter((m): m is CollectionManifest => m != null && this.isRoutable(m));
      const seen = new Set<string>();
      return resolved.filter((m) => {
        if (seen.has(m.id)) return false;
        seen.add(m.id);
        return true;
      });
    }
    const active = this.list().filter((m) => this.isRoutable(m));
    if (dimension === 'library') {
      return active.filter((m) => m.sensitivity === 'public' || m.sensitivity === 'internal');
    }
    if (dimension === 'project') {
      return active.filter((m) => m.kind === 'project');
    }
    if (dimension === 'global') {
      return active.filter((m) => m.kind === 'global');
    }
    return active.filter((m) => m.kind === 'project' || m.kind === 'global');
  }
}
