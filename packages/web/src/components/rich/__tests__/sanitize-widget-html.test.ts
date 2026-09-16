import DOMPurify from 'dompurify';
import { describe, expect, it } from 'vitest';
import { sanitizeWidgetHtml } from '../sanitize-widget-html';

function parse(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

describe('HTML widget script content', () => {
  it('preserves HTML literals, script order and exact raw text in head and body', () => {
    const first = '\nwindow.scene = `<div><span>ready</span></div>`;\n';
    const second = 'document.getElementById("out").innerHTML = window.scene;';
    const result = parse(
      sanitizeWidgetHtml(
        `<html><head><script>${first}</script></head><body><p id="out"></p><script>${second}</script></body></html>`,
      ),
    );
    expect(Array.from(result.scripts, (script) => script.textContent)).toEqual([first, second]);
    expect(result.head.querySelector('script')?.textContent).toBe(first);
    expect(result.body.querySelector('script')?.textContent).toBe(second);
  });

  it('preserves markup strings in JSON data scripts and empty scripts', () => {
    const data = '{"body":"<b>ready</b>","escaped":"&lt;still raw&gt;"}';
    const result = parse(sanitizeWidgetHtml(`<script type="application/json">${data}</script><script></script>`));
    expect(Array.from(result.scripts, (script) => script.textContent)).toEqual([data, '']);
    expect(result.scripts[0]?.type).toBe('application/json');
  });

  it('still sanitizes script attributes and the surrounding HTML/SVG markup', () => {
    const result = parse(
      sanitizeWidgetHtml(
        '<base href="https://invalid.test"><meta http-equiv="refresh" content="0;url=/leave">' +
          '<form action="/leave"><button formaction="/leave" onclick="bad()">Go</button></form>' +
          '<svg viewBox="0 0 10 10"><circle r="2" onload="bad()" /></svg>' +
          '<script id="author" src="javascript:bad()" onerror="bad()" formaction="/leave">' +
          'window.scene = "<div>ready</div>";</script>',
      ),
    );
    expect(result.querySelector('base,meta,form,[formaction],[onclick],[onload],[onerror]')).toBeNull();
    expect(result.querySelector('svg circle')).not.toBeNull();
    expect(result.querySelector('#author')?.getAttribute('src')).toBeNull();
    expect(result.querySelector('#author')?.textContent).toBe('window.scene = "<div>ready</div>";');
  });

  it('does not change namespace or mutation-XSS handling outside HTML scripts', () => {
    const samples = [
      '<svg><script><a href="javascript:bad()">bad</a></script><circle r="2" /></svg>',
      '<math><script><mtext>bad</mtext></script><mi>x</mi></math>',
      '<svg><foreignObject><p onclick="bad()">bad</p></foreignObject></svg>',
      '<svg><foreignObject><script>window.scene="<b>discard</b>"</script></foreignObject></svg>',
      '<math><annotation-xml encoding="text/html"><script>window.scene="<b>discard</b>"</script></annotation-xml></math>',
      '<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=bad()>">',
      '<svg></p><style><a id="</style><img src=x onerror=bad()>">',
    ];
    for (const html of samples) {
      const baseline = DOMPurify.sanitize(html, {
        WHOLE_DOCUMENT: true,
        ADD_TAGS: ['script'],
        FORBID_TAGS: ['form', 'base', 'meta'],
        FORBID_ATTR: ['formaction'],
      });
      const result = sanitizeWidgetHtml(html);
      expect(result).toBe(baseline);
      expect(parse(result).querySelector('[onerror],[onclick],[href^="javascript:"]')).toBeNull();
    }
  });

  it('preserves raw text in an inert HTML template without moving its script into the document', () => {
    const script = 'window.scene = "<b>template</b>";';
    const result = parse(sanitizeWidgetHtml(`<template><script>${script}</script></template>`));
    expect(result.scripts).toHaveLength(0);
    expect(result.querySelector('template')?.content.querySelector('script')?.textContent).toBe(script);
  });

  it('keeps default sanitization and separate calls independent', () => {
    const html = '<script>window.scene = "<span>first</span>";</script>';
    const baseline = DOMPurify.sanitize(html);
    expect(parse(sanitizeWidgetHtml(html)).scripts[0]?.textContent).toContain('<span>first</span>');
    expect(parse(sanitizeWidgetHtml('<p>second</p>')).scripts).toHaveLength(0);
    expect(DOMPurify.sanitize(html)).toBe(baseline);
    expect(parse(DOMPurify.sanitize(html)).scripts).toHaveLength(0);
  });
});
