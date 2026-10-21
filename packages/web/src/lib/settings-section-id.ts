/** Retired settings identities share a destination across bookmarks and saved pins. */
export function canonicalSettingsSectionId(id: string): string {
  return id === 'im' ? 'plugins' : id;
}
