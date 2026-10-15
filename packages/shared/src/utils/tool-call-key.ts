export interface NativeToolCallIdentity {
  toolUseId?: string;
  toolParentUseId?: string;
}

/** Native IDs remain unchanged on events; this key only scopes consumer pairing. */
export function nativeToolCallKey(event: NativeToolCallIdentity): string | undefined {
  if (!event.toolUseId) return undefined;
  return event.toolParentUseId ? JSON.stringify([event.toolParentUseId, event.toolUseId]) : event.toolUseId;
}
