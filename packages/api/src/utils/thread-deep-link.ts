export function buildThreadDeepLink(frontendBaseUrl: string, threadId: string): string {
  return `${frontendBaseUrl}/thread/${threadId}`;
}
