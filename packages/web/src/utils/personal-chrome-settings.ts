export function personalChromeSettingsHref(threadId: string): string {
  const params = new URLSearchParams({ s: 'plugins', threadId });
  return `/settings?${params.toString()}#personal-chatgpt-pro`;
}
