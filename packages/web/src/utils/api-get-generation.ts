const responseGetGenerations = new WeakMap<Response, number>();

export function markApiGetGeneration(response: Response, generation: number): void {
  responseGetGenerations.set(response, generation);
}

export function getApiGetGeneration(response: Response): number | null {
  return responseGetGenerations.get(response) ?? null;
}
