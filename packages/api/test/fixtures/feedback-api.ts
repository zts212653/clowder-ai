/** Isolated browser fixture transport. Production component still uses its real session client. */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(path, init);
}
