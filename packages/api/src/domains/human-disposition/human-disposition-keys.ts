function encodeKeyPart(value: string, label: string): string {
  const canonical = value.trim();
  if (canonical.length === 0 || canonical.length > 500) {
    throw new Error(`${label} must contain 1..500 characters`);
  }
  return Buffer.from(canonical, 'utf8').toString('base64url');
}

export const HumanDispositionKeys = {
  receipts(ownerUserId: string): string {
    return `human-disposition:receipts:${encodeKeyPart(ownerUserId, 'ownerUserId')}`;
  },

  episodes(ownerUserId: string): string {
    return `human-disposition:episodes:${encodeKeyPart(ownerUserId, 'ownerUserId')}`;
  },

  subject(ownerUserId: string, subjectRef: string): string {
    return `human-disposition:subject:${encodeKeyPart(ownerUserId, 'ownerUserId')}:${encodeKeyPart(subjectRef, 'subjectRef')}`;
  },
};
