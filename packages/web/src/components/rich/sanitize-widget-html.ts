/**
 * F156 D-3: Sanitize HTML widget content before iframe injection.
 *
 * The iframe sandbox="allow-scripts" (no allow-same-origin) already blocks
 * cookie/localStorage access. DOMPurify adds defense-in-depth against:
 * - <form> with external action (data exfiltration)
 * - <meta http-equiv="refresh"> (redirect)
 * - <base> tag (URL hijacking)
 *
 * Scripts are intentionally preserved — widgets need JS for charts/interactivity.
 *
 * Inline event handler attributes (onclick, onmouseover, …) are NOT preserved:
 * DOMPurify's default ALLOWED_ATTR carries no on* handlers and we deliberately do
 * not add them back. Nothing is lost — widgets bind listeners from inside <script>
 * (addEventListener, or `el.onclick = …`, which never passes through the sanitizer),
 * so allowing inline handlers would widen the XSS surface for syntax sugar alone.
 * Authoring guidance lives in cat-cafe-skills/rich-messaging/SKILL.md.
 */
import DOMPurify from 'dompurify';

export function sanitizeWidgetHtml(html: string): string {
  // Hooks belong only to this call, never the shared purifier used elsewhere.
  const purifier = DOMPurify(window);
  const scriptText = new WeakMap<Node, string>();
  purifier.addHook('beforeSanitizeElements', (node) => {
    if (
      !(node instanceof Element) ||
      node.nodeName !== 'SCRIPT' ||
      node.namespaceURI !== 'http://www.w3.org/1999/xhtml'
    )
      return;
    // HTML script bodies are raw text, including JS strings containing markup.
    // DOMPurify's SAFE_FOR_XML mXSS heuristic otherwise removes the whole script.
    // Leave that check enabled for markup and foreign (SVG/MathML) namespaces.
    scriptText.set(node, node.textContent ?? '');
    node.textContent = '';
  });
  purifier.addHook('afterSanitizeAttributes', (node) => {
    const text = scriptText.get(node);
    if (text !== undefined) node.textContent = text;
    // No nodes are reinserted: tag/namespace removal and attribute checks still win.
  });

  return purifier.sanitize(html, {
    // Widgets are complete HTML documents — preserve <html>/<head>/<style>
    WHOLE_DOCUMENT: true,
    // Keep <script> — widget functionality needs it
    ADD_TAGS: ['script'],
    // Block data exfiltration vectors
    FORBID_TAGS: ['form', 'base', 'meta'],
    // Block attributes that could exfiltrate data
    FORBID_ATTR: ['formaction'],
    // No ADD_ATTR by design — see the note on inline event handlers above
  });
}
