/**
 * F120 Phase C: Bridge script injected into previewed pages via Preview Gateway.
 * Patches console.* methods → postMessage to parent (Hub).
 * Handles screenshot requests via SVG foreignObject + canvas.
 */

export const BRIDGE_SCRIPT = `
<script data-cat-cafe-bridge="true">
(function() {
  if (window.__catCafeBridge) return;
  window.__catCafeBridge = true;

  // --- Console patching ---
  var origConsole = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console)
  };

  function patchLevel(level) {
    console[level] = function() {
      origConsole[level].apply(console, arguments);
      try {
        var args = [];
        for (var i = 0; i < arguments.length; i++) {
          try {
            args.push(typeof arguments[i] === 'object' ? JSON.stringify(arguments[i]) : String(arguments[i]));
          } catch(e) {
            args.push('[unserializable]');
          }
        }
        parent.postMessage({
          type: 'console',
          source: 'cat-cafe-bridge',
          level: level,
          args: args,
          timestamp: Date.now()
        }, '*');
      } catch(e) {}
    };
  }

  patchLevel('log');
  patchLevel('warn');
  patchLevel('error');
  patchLevel('info');

  // --- Uncaught error capture ---
  window.addEventListener('error', function(e) {
    parent.postMessage({
      type: 'console',
      source: 'cat-cafe-bridge',
      level: 'error',
      args: [e.message + ' at ' + (e.filename || '') + ':' + (e.lineno || 0)],
      timestamp: Date.now()
    }, '*');
  });

  // --- Screenshot handler ---
  window.addEventListener('message', function(e) {
    if (!e.data || e.data.source !== 'cat-cafe-preview' || e.source !== parent) return;

    if (e.data.type === 'visible-page-admission-request') {
      var admission = e.data.admission || {};
      var requiredDom = Array.isArray(admission.requiredDom) ? admission.requiredDom : [];
      var forbiddenText = Array.isArray(admission.forbiddenText) ? admission.forbiddenText : [];
      var pageText = document.body ? (document.body.innerText || document.body.textContent || '') : '';
      var dom = requiredDom.map(function(assertion) {
        var element = null;
        try {
          element = document.querySelector(assertion.selector);
        } catch(err) {}
        var attributes = {};
        var expectedAttributes = assertion.attributes || {};
        Object.keys(expectedAttributes).forEach(function(name) {
          attributes[name] = element ? element.getAttribute(name) : null;
        });
        var elementText = element ? (element.innerText || element.textContent || '') : '';
        var textIncludes = Array.isArray(assertion.textIncludes) ? assertion.textIncludes : [];
        return {
          selector: assertion.selector,
          found: !!element,
          attributes: attributes,
          textMatches: textIncludes.map(function(text) { return elementText.indexOf(text) !== -1; })
        };
      });
      parent.postMessage({
        type: 'visible-page-attestation',
        source: 'cat-cafe-bridge',
        attestation: {
          eventId: e.data.eventId,
          targetPort: e.data.targetPort,
          targetOrigin: window.location.origin,
          targetPath: window.location.pathname + window.location.search + window.location.hash,
          clientRevision: document.documentElement.getAttribute('data-cat-cafe-build-revision'),
          dom: dom,
          forbiddenTextMatches: forbiddenText.map(function(text) { return pageText.indexOf(text) !== -1; })
        }
      }, '*');
      return;
    }

    if (e.data.type !== 'screenshot-request') return;
    try {
      var html = document.documentElement.outerHTML;
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + document.documentElement.scrollWidth + '" height="' + document.documentElement.scrollHeight + '">' +
        '<foreignObject width="100%" height="100%">' +
        '<div xmlns="http://www.w3.org/1999/xhtml">' + html + '</div>' +
        '</foreignObject></svg>';
      var img = new Image();
      img.onload = function() {
        var canvas = document.createElement('canvas');
        canvas.width = Math.min(img.width, 1920);
        canvas.height = Math.min(img.height, 1080);
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        parent.postMessage({
          type: 'screenshot-result',
          source: 'cat-cafe-bridge',
          dataUrl: canvas.toDataURL('image/png')
        }, '*');
      };
      img.onerror = function() {
        parent.postMessage({
          type: 'screenshot-error',
          source: 'cat-cafe-bridge',
          error: 'SVG foreignObject rendering failed'
        }, '*');
      };
      img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
    } catch(e) {
      parent.postMessage({
        type: 'screenshot-error',
        source: 'cat-cafe-bridge',
        error: e.message || 'Screenshot failed'
      }, '*');
    }
  });
})();
</script>`;
