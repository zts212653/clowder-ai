export type ClientRequest = <Result>(path: string, init?: RequestInit) => Promise<Result>;

export function collectiveClientErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class CollectiveClientRequestError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(detail);
  }
}
