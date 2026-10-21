/** The installed package's own operations in the existing Plugin Manager. */
export function personalChromeSettingsHref(): string {
  const params = new URLSearchParams({
    s: 'plugins',
    pluginManagerLive: '1',
    plugin: 'official.companion.personal-chrome',
  });
  return `/settings?${params.toString()}`;
}
