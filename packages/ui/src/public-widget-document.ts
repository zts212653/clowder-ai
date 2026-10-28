import { sanitizeWidgetHtml } from './sanitize-widget-html';

/** Keep the outer nonce-only policy, then restrict widgets to content embedded in their own document. */
export function publicWidgetDocument(html: string, nonce: string): string {
  if (!/^[A-Za-z0-9_-]{20,100}$/u.test(nonce)) throw new Error('Widget document permission is unavailable');
  const document = new DOMParser().parseFromString(sanitizeWidgetHtml(html), 'text/html');
  for (const script of document.querySelectorAll('script')) {
    if (script.src) script.remove();
    else script.setAttribute('nonce', nonce);
  }
  for (const style of document.querySelectorAll('style')) style.setAttribute('nonce', nonce);
  // Initial style attributes cannot carry a nonce. Preserve parsed declarations in an authorized stylesheet.
  const rules: string[] = [];
  for (const [index, element] of [...document.querySelectorAll<HTMLElement>('[style]')].entries()) {
    const id = `cafe-widget-inline-${index}`;
    rules.push(`[data-cafe-widget-style="${id}"]{${element.style.cssText}}`);
    element.setAttribute('data-cafe-widget-style', id);
    element.removeAttribute('style');
  }
  if (rules.length) {
    const style = document.createElement('style');
    style.setAttribute('nonce', nonce);
    style.textContent = rules.join('\n').replace(/<\/style/giu, '<\\/style');
    document.head.append(style);
  }
  const policy = document.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  // No child nonce source: even a script that learns its nonce cannot authorize an external script.
  policy.content =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
  document.head.prepend(policy);
  return `<!doctype html>${document.documentElement.outerHTML}`;
}
