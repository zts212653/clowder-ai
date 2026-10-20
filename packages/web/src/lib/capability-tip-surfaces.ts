/** F190: incomplete destinations are not promoted by ambient capability tips. */
export const HIDDEN_TIP_DESTINATIONS: Readonly<Record<string, string>> = {
  collective: '/collective',
  starry: '/starry',
};

export const CAPABILITY_SURFACE_ROUTES: Readonly<Record<string, string>> = {
  'new-conversation': '/',
  'settings.plugins': '/settings?s=plugins',
};

export function isHiddenTipDestination(destination: string): boolean {
  if (Object.hasOwn(HIDDEN_TIP_DESTINATIONS, destination)) return true;
  const pathname = destination.split(/[?#]/, 1)[0];
  return Object.values(HIDDEN_TIP_DESTINATIONS).some((path) => pathname === path || pathname.startsWith(`${path}/`));
}
