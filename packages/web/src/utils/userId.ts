/**
 * Legacy userId source for POST body fields (same-origin, not an attack vector).
 * F156 D-1: primary identity is now the HttpOnly session cookie, not this value.
 */

const STORAGE_KEY = 'cat-cafe-userId';
const DEFAULT_USER = 'default-user';

export function getUserId(): string {
  if (typeof window === 'undefined') return DEFAULT_USER;
  return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_USER;
}

export function setUserId(id: string): void {
  if (typeof window !== 'undefined') {
    localStorage.setItem(STORAGE_KEY, id);
  }
}
