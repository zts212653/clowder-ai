/** Only an explicit Web runtime port is public; never infer a production default. */
export function runtimeApiOriginFromPort(port: string | undefined): string | undefined {
  if (!port || !/^\d{1,5}$/.test(port)) return undefined;
  const value = Number(port);
  return value >= 1 && value <= 65535 ? `http://localhost:${value}` : undefined;
}
