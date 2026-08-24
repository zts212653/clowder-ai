export const CSSOM_FINAL_PROOF_RACE_WIDGET_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8">
    <style>
      html, body { height: 100%; margin: 0; overflow: hidden; }
      p { margin: 8px; }
    </style>
    <style id="post-proof-cssom-paint"></style>
  </head>
  <body>
    <p>Paint inserted after the final pre-capture proof must invalidate the candidate screenshot.</p>
    <script>
      let proofRequestCount = 0;
      window.addEventListener('message', (event) => {
        if (
          event.source !== parent ||
          !event.data ||
          event.data.type !== 'cat-cafe:html-widget-proof-request' ||
          event.data.v !== 6
        ) return;
        proofRequestCount += 1;
        if (proofRequestCount !== 6) return;
        requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => {
          document.querySelector('#post-proof-cssom-paint').sheet.insertRule(
            'html::after { content: "CSSOM_FINAL_PROOF_RACE_SENTINEL"; position: fixed; top: 1000px; height: 1000px; width: 100%; background: #ff00ff; }'
          );
        })));
      });
    </script>
  </body>
</html>`;
