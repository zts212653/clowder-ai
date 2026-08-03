import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MarkdownContent, normalizeMathDelimiters } from '@/components/MarkdownContent';

Object.assign(globalThis as Record<string, unknown>, { React });

describe('normalizeMathDelimiters', () => {
  it('converts \\[...\\] display math to $$...$$', () => {
    expect(normalizeMathDelimiters('\\[\nN = 1\n\\]')).toBe('$$\nN = 1\n$$');
  });

  it('converts \\(...\\) inline math to $$...$$ (inline math with single-dollar off)', () => {
    expect(normalizeMathDelimiters('公式 \\(E=mc^2\\) 完')).toBe('公式 $$E=mc^2$$ 完');
  });

  it('does not touch fenced code blocks (``` or ~~~)', () => {
    const backtick = '```\n\\[ not math \\]\n```';
    const tilde = '~~~\n\\(x\\)\n~~~';
    expect(normalizeMathDelimiters(backtick)).toBe(backtick);
    expect(normalizeMathDelimiters(tilde)).toBe(tilde);
  });

  it('does not touch indented code blocks', () => {
    const indented = '前文\n\n    \\[ not math \\]\n\n后文';
    expect(normalizeMathDelimiters(indented)).toBe(indented);
  });

  it('does not touch code spans, including double-backtick spans', () => {
    const single = '`\\(x\\)` 是代码';
    const double = '`` `\\(x\\)` `` 也是代码';
    expect(normalizeMathDelimiters(single)).toBe(single);
    expect(normalizeMathDelimiters(double)).toBe(double);
  });
});

describe('MarkdownContent math rendering', () => {
  it('renders \\[...\\] display math via KaTeX instead of raw text', () => {
    const html = renderToStaticMarkup(
      <MarkdownContent
        content={'最终 ROI：\n\n\\[\nN_{\\text{break-even}} = \\frac{C_{\\text{数据}}}{C_{\\text{节省}}}\n\\]'}
      />,
    );
    expect(html).toContain('katex-display');
    // Visible output must be rendered math (mfrac), not literal source text
    expect(html).toContain('<mfrac>');
  });

  it('renders $$...$$ display math via KaTeX', () => {
    const html = renderToStaticMarkup(<MarkdownContent content={'$$\nx^2 + y^2 = z^2\n$$'} />);
    expect(html).toContain('katex-display');
  });

  it('renders inline math $$...$$ and \\(...\\) via KaTeX', () => {
    const html = renderToStaticMarkup(<MarkdownContent content={'质能方程 $$E=mc^2$$ 与 \\(a+b\\)'} />);
    expect(html.match(/class="katex"/g)?.length).toBe(2);
  });

  it('does not render single-$ text as math (currency stays text)', () => {
    const html = renderToStaticMarkup(<MarkdownContent content={'预算是 $5 和 $10 的区别'} />);
    expect(html).not.toContain('katex');
    expect(html).toContain('$5');
    expect(html).toContain('$10');
  });

  it('leaves math-like text inside code blocks untouched', () => {
    const fenced = renderToStaticMarkup(<MarkdownContent content={'```\n\\[ raw \\]\n```'} />);
    expect(fenced).not.toContain('katex');
    expect(fenced).toContain('\\[ raw \\]');

    const tilde = renderToStaticMarkup(<MarkdownContent content={'~~~\n\\( raw \\)\n~~~'} />);
    expect(tilde).not.toContain('katex');
    expect(tilde).toContain('\\( raw \\)');

    const span = renderToStaticMarkup(<MarkdownContent content={'`\\(x\\)` 保持原样'} />);
    expect(span).not.toContain('katex');
  });
});
