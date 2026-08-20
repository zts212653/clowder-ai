import { buildPreviewGatewayUrl } from '@cat-cafe/shared';

export function getPreviewBridgeOrigin(gatewayPort: number, targetPort: number): string | null {
  if (!gatewayPort || !targetPort) return null;
  return new URL(buildPreviewGatewayUrl(gatewayPort, targetPort)).origin;
}

export function isValidBridgeOrigin(
  eventOrigin: string,
  gatewayPort: number,
  targetPort: number,
  hubOrigin: string,
): boolean {
  if (!gatewayPort) return true;
  const previewOrigin = getPreviewBridgeOrigin(gatewayPort, targetPort);
  const validOrigins = [
    previewOrigin,
    // Compatibility with already-mounted query-routed preview iframes.
    `http://localhost:${gatewayPort}`,
    `http://127.0.0.1:${gatewayPort}`,
    hubOrigin,
  ];
  return validOrigins.includes(eventOrigin);
}
