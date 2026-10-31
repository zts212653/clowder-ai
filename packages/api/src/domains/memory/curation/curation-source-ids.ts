/** Normalize native representation only within the exact permitted source set.
 * A shortened timestamp/suffix is never searched against the wider corpus. */
export function curationSourceIdResolver(permitted: ReadonlySet<string>) {
  const aliases = new Map<string, string | null>();
  for (const id of permitted) aliases.set(id, id);
  for (const id of permitted) {
    const parts = id.match(/^(\d{16})-\d{6}-([a-f0-9]{8})$/);
    if (!parts) continue;
    const shorthand = `${parts[1]}-${parts[2]}`;
    const existing = aliases.get(shorthand);
    aliases.set(shorthand, existing === undefined || existing === id ? id : null);
  }
  return (label: string): string | null => {
    const exact = label.trim();
    if (aliases.has(exact)) return aliases.get(exact) ?? null;
    return aliases.get(exact.replace(/^message\s+/i, '')) ?? null;
  };
}
