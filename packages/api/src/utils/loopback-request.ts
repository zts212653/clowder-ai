const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function isLoopbackAddress(address: string): boolean {
  return LOOPBACK_ADDRS.has(address);
}
