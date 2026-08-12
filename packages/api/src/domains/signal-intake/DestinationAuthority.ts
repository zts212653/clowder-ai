export type HostDestinationKind = 'private-thread' | 'channel';

export interface HostDestinationRecord {
  readonly handle: string;
  readonly kind: HostDestinationKind;
  readonly targetId: string;
  readonly ownerId?: string;
}

export interface DestinationAuthority {
  resolve(handle: string, ownerId: string): Promise<HostDestinationRecord | null>;
}

export class MemoryDestinationAuthority implements DestinationAuthority {
  private readonly records = new Map<string, HostDestinationRecord>();

  put(record: HostDestinationRecord): void {
    this.records.set(record.handle, structuredClone(record));
  }

  async resolve(handle: string, ownerId: string): Promise<HostDestinationRecord | null> {
    const record = this.records.get(handle);
    if (record?.ownerId !== undefined && record.ownerId !== ownerId) return null;
    return record ? structuredClone(record) : null;
  }
}
