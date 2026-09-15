export function resolveChromeWebStoreDistribution(webStoreListingUrl, extensionId) {
  if (webStoreListingUrl === undefined || webStoreListingUrl === '') {
    return {
      channel: 'chrome_web_store',
      integration: 'ready',
      publication: 'unavailable',
      blockerCode: 'CHROME_WEB_STORE_LISTING_NOT_CONFIGURED',
    };
  }
  try {
    if (typeof webStoreListingUrl !== 'string' || webStoreListingUrl.trim() !== webStoreListingUrl) {
      throw new Error('listing URL must be exact');
    }
    const url = new URL(webStoreListingUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    if (
      url.protocol !== 'https:' ||
      url.hostname !== 'chromewebstore.google.com' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      segments[0] !== 'detail' ||
      segments.length < 2 ||
      segments.at(-1) !== extensionId
    ) {
      throw new Error('listing URL is not the expected Chrome Web Store listing');
    }
    return {
      channel: 'chrome_web_store',
      integration: 'ready',
      publication: 'published',
      listingUrl: url.href,
    };
  } catch {
    return {
      channel: 'chrome_web_store',
      integration: 'ready',
      publication: 'invalid',
      blockerCode: 'CHROME_WEB_STORE_LISTING_INVALID',
    };
  }
}
