/** The Personal ChatGPT Pro plugin settings: install, repair, and conversation authorizations. */
export function personalChromeSettingsHref(): string {
  const params = new URLSearchParams({ s: 'plugins' });
  return `/settings?${params.toString()}#personal-chatgpt-pro`;
}
