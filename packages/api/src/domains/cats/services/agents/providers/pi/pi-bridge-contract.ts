export const PI_BRIDGE_NAME = 'clowder-pi-bridge';
/** An exact native binding must never enter the Host's generic create-after-load-failure fallback. */
export const PI_SESSION_BINDING_ERROR = -32004;
/** A validated cold session needs a new Host history segment before any replacement prompt. */
export const PI_SESSION_BINDING_CHANGED = -32005;

/** Some line-oriented consumers treat Unicode separators as record boundaries. */
export function encodePiAcpRecord(value: unknown): string {
  return `${JSON.stringify(value)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')}\n`;
}
