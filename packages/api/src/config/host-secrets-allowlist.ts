/** Host web-push credentials; plugin credentials belong to plugin configuration. */
export const HOST_SECRETS_ALLOWLIST: ReadonlySet<string> = new Set([
  'VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'VAPID_SUBJECT',
]);

export function isHostSecret(name: string): boolean {
  return HOST_SECRETS_ALLOWLIST.has(name);
}
