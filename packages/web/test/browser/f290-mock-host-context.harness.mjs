/** API-mocked Host pages run without PWA registration; native API journeys keep the real browser capability. */
export async function disableMockHostPwa(context, hostOrigin) {
  await context.addInitScript((origin) => {
    if (location.origin !== origin) return;
    // Playwright's blocked register() resolves undefined, which Workbox treats
    // as a registration. Remove the capability before its feature detection.
    delete Object.getPrototypeOf(navigator).serviceWorker;
  }, hostOrigin);
}
