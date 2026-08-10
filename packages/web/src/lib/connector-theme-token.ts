/** CSS custom-property fragments cannot contain arbitrary connector ID characters. */
export function connectorThemeToken(connectorId: string): string {
  return connectorId.replace(/[^a-zA-Z0-9_-]/g, '-');
}
