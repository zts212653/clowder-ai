/** Shared vocabulary of the credential-free compatibility probes. */
export class CheckFailed extends Error {}
export type Check = (id: string, assertion: () => unknown | Promise<unknown>) => Promise<void>;
/** Allocates a short unix socket path (macOS caps them at 104 bytes). */
export type Socket = () => string;
export function expect(condition: unknown, detail: string): void {
  if (!condition) throw new CheckFailed(detail);
}
export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
