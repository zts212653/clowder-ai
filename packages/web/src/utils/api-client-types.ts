export interface ApiFetchOptions {
  /**
   * A mutation happened while this exact GET may already be active. Attach the
   * caller to one bounded trailing generation instead of the possibly stale one.
   */
  afterCurrentGet?: boolean;
  /**
   * Carry a representation validator on this physical GET generation without
   * partitioning the exact-resource coordination key.
   */
  ifNoneMatch?: string | null;
}

export interface GetGeneration {
  id: number;
  promise: Promise<Response>;
  resolve(response: Response): void;
  reject(error: unknown): void;
  path: string;
  init: RequestInit | undefined;
  ifNoneMatch: string | null | undefined;
}

export interface GetCoordinationState {
  active: GetGeneration;
  trailing: GetGeneration | null;
}
