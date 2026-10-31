export function createBrowserPort(page) {
  return {
    async inspect() {
      return page.evaluate(() => {
        const quote = document.querySelector('#quoted-content')?.textContent?.trim() ?? '';
        const readback = document.querySelector('#readback');
        if (!(readback instanceof HTMLOutputElement)) throw new Error('Canonical page readback unavailable');
        const candidates = Array.from(document.querySelectorAll('[data-action-id]'))
          .filter(
            (element) => element instanceof HTMLElement && element.getClientRects().length > 0 && !element.disabled,
          )
          .map((element) => {
            const operation = element instanceof HTMLInputElement ? 'fill' : 'click';
            const label =
              element.getAttribute('aria-label') ||
              element.labels?.[0]?.textContent?.trim() ||
              element.textContent?.trim() ||
              '';
            const fingerprint = JSON.stringify([
              element.tagName,
              element.id,
              element.getAttribute('data-action-id'),
              element.getAttribute('data-revision'),
              label,
              element instanceof HTMLInputElement ? element.value : null,
            ]);
            return {
              id: element.getAttribute('data-action-id'),
              operation,
              label,
              fingerprint,
              untrustedContext: quote,
            };
          });
        return {
          origin: location.origin,
          url: location.href,
          readback: readback.textContent,
          candidates,
        };
      });
    },
    async perform(choice, expectedFingerprint, expectedUrl, expectedRequestRevision) {
      return page.evaluate(
        ({ choice, expectedFingerprint, expectedUrl, expectedRequestRevision }) => {
          function liveTarget(targetId) {
            const found = Array.from(document.querySelectorAll('[data-action-id]')).find(
              (item) => item.getAttribute('data-action-id') === targetId,
            );
            if (!(found instanceof HTMLElement)) return null;
            if (found.getClientRects().length === 0 || found.disabled) return null;
            return found;
          }
          function fingerprint(element) {
            const label =
              element.getAttribute('aria-label') ||
              element.labels?.[0]?.textContent?.trim() ||
              element.textContent?.trim() ||
              '';
            return JSON.stringify([
              element.tagName,
              element.id,
              element.getAttribute('data-action-id'),
              element.getAttribute('data-revision'),
              label,
              element instanceof HTMLInputElement ? element.value : null,
            ]);
          }
          function act(element) {
            if (choice.operation === 'click' && element instanceof HTMLButtonElement) {
              element.click();
              return 'applied';
            }
            if (
              choice.operation === 'fill' &&
              element instanceof HTMLInputElement &&
              typeof choice.value === 'string'
            ) {
              element.value = choice.value;
              element.dispatchEvent(new Event('input', { bubbles: true }));
              element.dispatchEvent(new Event('change', { bubbles: true }));
              return 'applied';
            }
            return 'stale';
          }
          if (location.href !== expectedUrl) return 'stale';
          if (window.actionRequestRevision !== expectedRequestRevision) return 'changed_request';
          const element = liveTarget(choice.targetId);
          if (!element || fingerprint(element) !== expectedFingerprint) return 'stale';
          return act(element);
        },
        { choice, expectedFingerprint, expectedUrl, expectedRequestRevision },
      );
    },
  };
}
