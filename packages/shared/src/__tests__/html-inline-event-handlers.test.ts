import { describe, expect, it } from 'vitest';
import { findInlineEventHandlerAttributes as find } from '../html-inline-event-handlers.js';

describe('findInlineEventHandlerAttributes (#1640)', () => {
  it('reports real start-tag attributes with any quoting or casing, unique and in source order', () => {
    expect(
      find(
        `<!doctype html><html><body>
          <button ONCLICK="a()">a</button>
          <div onmouseover='b()' onclick=c()>b</div>
          <img src=x onerror=d()/>
          <input type=text oninput = "e()">
          <noscript><a onfocus="f()">x</a></noscript>
          <svg><script>g()</script><rect onclick="h()"/></svg>
        </body></html>`,
      ),
    ).toEqual(['onclick', 'onmouseover', 'onerror', 'oninput', 'onfocus']);
  });

  it('treats tags inside <svg> script as markup, matching the HTML parser', () => {
    expect(find(`<svg><script>'<b onload="x">'</script></svg>`)).toEqual(['onload']);
  });

  it('ignores script strings, comments, raw-text bodies and prose', () => {
    expect(
      find(`<!-- <button onclick="old()"> -->
        <p>Do not write onclick="foo()" — use addEventListener.</p>
        <p>a &lt;button onclick="x"&gt; b</p>
        <script>
          const tpl = '<button onclick="go()">go</button>';
          // el.onclick = handler; <div onmouseover=x>
          document.getElementById('b').addEventListener('click', () => {});
          if (a < b && c > d) {}
        </script>
        <style>/* <a onclick=x> */ .x::before { content: "<i onclick=y>"; }</style>
        <textarea><b onclick="z"></b></textarea>
        <title><i onload=x></title>
        </SCRIPT><button id="b" data-onclick="x" aria-label="onclick">go</button>
        <?xml onclick="x"?><![CDATA[<b onclick=x>]]>`),
    ).toEqual([]);
  });

  it('does not end a script early on a lookalike closing tag', () => {
    expect(find(`<script>const s = "</scripts><b onclick=x>";</script><p>ok</p>`)).toEqual([]);
  });

  it('keeps quoted attribute values containing > or other attribute-like text inside the value', () => {
    expect(find(`<a title="x > y onclick=z" href="#">ok</a><b data-x='onmouseover=1'>`)).toEqual([]);
  });

  it('ignores attributes on end tags and unterminated input', () => {
    expect(find(`<p></p onclick="x">`)).toEqual([]);
    expect(find(`<button onclick="x`)).toEqual(['onclick']);
    expect(find(`<!-- <b onclick=x>`)).toEqual([]);
  });
});
