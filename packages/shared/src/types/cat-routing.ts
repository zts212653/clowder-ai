import type { CatId } from './ids.js';

export interface CatAlternative {
  readonly catId: CatId;
  readonly mention: string;
  readonly displayName: string;
  readonly family: string;
}

export type CatRoutingError =
  | { kind: 'cat_not_found'; mention: string; alternatives: CatAlternative[] }
  | { kind: 'cat_disabled'; catId: CatId; displayName: string; alternatives: CatAlternative[] };
