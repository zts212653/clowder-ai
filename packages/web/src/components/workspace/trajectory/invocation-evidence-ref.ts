export function invocationIdFromEvidenceRef(value: string): string | undefined {
  const match = /^inv:([^:\s]+)$/.exec(value.trim());
  return match?.[1];
}
