/**
 * F208 Phase D: DossierObservationStore — operator observation staging layer.
 *
 * AC-D1: operator writes observations + provenance, stored in pending layer.
 * OQ-10: Phase D = staging + read display; promotion to summary layer in Phase E.
 * AC-D3: Observations do NOT auto-replace summary layer (peer/operator judgment + provenance).
 *
 * Interface + in-memory implementation (test / single-process dev).
 * Redis implementation lives in ../redis/RedisDossierObservationStore.ts.
 */

import { nanoid } from 'nanoid';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DossierObservationProvenance {
  type: 'cvo';
  author: string;
  date: string; // ISO date (YYYY-MM-DD)
}

export interface DossierObservation {
  id: string;
  catId: string;
  content: string;
  provenance: DossierObservationProvenance;
  createdAt: number; // epoch ms
}

export interface AddDossierObservationInput {
  catId: string;
  content: string;
  author: string;
}

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

export interface IDossierObservationStore {
  add(input: AddDossierObservationInput): DossierObservation | Promise<DossierObservation>;
  list(catId: string, limit?: number): DossierObservation[] | Promise<DossierObservation[]>;
  listAll(limit?: number): Record<string, DossierObservation[]> | Promise<Record<string, DossierObservation[]>>;
  get(id: string): DossierObservation | null | Promise<DossierObservation | null>;
  delete(id: string): boolean | Promise<boolean>;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

const DEFAULT_LIST_LIMIT = 100;

export class InMemoryDossierObservationStore implements IDossierObservationStore {
  private readonly observations = new Map<string, DossierObservation>();
  /** Monotonic insertion index — tiebreaker when Date.now() returns same ms. */
  private insertionIdx = 0;
  private readonly orderMap = new Map<string, number>();

  add(input: AddDossierObservationInput): DossierObservation {
    const now = Date.now();
    const obs: DossierObservation = {
      id: `obs_${nanoid(12)}`,
      catId: input.catId,
      content: input.content,
      provenance: {
        type: 'cvo',
        author: input.author,
        date: new Date(now).toISOString().slice(0, 10),
      },
      createdAt: now,
    };
    this.observations.set(obs.id, obs);
    this.orderMap.set(obs.id, this.insertionIdx++);
    return clone(obs);
  }

  list(catId: string, limit: number = DEFAULT_LIST_LIMIT): DossierObservation[] {
    const result: DossierObservation[] = [];
    for (const obs of this.observations.values()) {
      if (obs.catId === catId) result.push(clone(obs));
    }
    result.sort((a, b) => this.compareNewestFirst(a, b));
    return result.slice(0, Math.max(0, limit));
  }

  listAll(limit: number = DEFAULT_LIST_LIMIT): Record<string, DossierObservation[]> {
    const grouped: Record<string, DossierObservation[]> = {};
    for (const obs of this.observations.values()) {
      if (!grouped[obs.catId]) grouped[obs.catId] = [];
      grouped[obs.catId].push(clone(obs));
    }
    for (const catId of Object.keys(grouped)) {
      grouped[catId].sort((a, b) => this.compareNewestFirst(a, b));
      grouped[catId] = grouped[catId].slice(0, Math.max(0, limit));
    }
    return grouped;
  }

  get(id: string): DossierObservation | null {
    const found = this.observations.get(id);
    return found ? clone(found) : null;
  }

  delete(id: string): boolean {
    this.orderMap.delete(id);
    return this.observations.delete(id);
  }

  /** Newest first: higher createdAt wins; same ms → higher insertionIdx wins. */
  private compareNewestFirst(a: DossierObservation, b: DossierObservation): number {
    if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
    return (this.orderMap.get(b.id) ?? 0) - (this.orderMap.get(a.id) ?? 0);
  }
}

function clone(obs: DossierObservation): DossierObservation {
  return { ...obs, provenance: { ...obs.provenance } };
}
