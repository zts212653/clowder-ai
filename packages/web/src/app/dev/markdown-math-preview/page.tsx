/**
 * Math rendering visual-evidence fixture (unlinked, development-only).
 *
 * Renders MarkdownContent with representative LaTeX inputs — \[...\] display
 * math (the original bug report), \(...\) inline math, $$...$$, currency
 * false-positive guard, and code-block exemption — for reproducible
 * pixel-level acceptance before merge.
 */

import { notFound } from 'next/navigation';
import { MarkdownContent } from '@/components/MarkdownContent';

const SAMPLES: Array<{ title: string; content: string }> = [
  {
    title: '\\[...\\] display math（原始 bug 截图同款）',
    content:
      '最终 ROI 仍然只有这条式子：\n\n\\[\nN_{\\text{break-even}} = \\frac{C_{\\text{数据}}+C_{\\text{SFT}}+C_{\\text{GRPO}}+C_{\\text{教师调用}}+C_{\\text{工程}}+C_{\\text{维护}}}{C_{\\text{大猫直跑}}-C_{\\text{混合推理}}}\n\\]',
  },
  {
    title: '\\(...\\) inline math',
    content: '质能方程 \\(E=mc^2\\) 与勾股定理 \\(a^2+b^2=c^2\\) 都是行内公式。',
  },
  {
    title: '$$...$$ inline / block',
    content: '行内 $$x^2$$ 试试。\n\n$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$',
  },
  {
    title: '货币单 $ 不渲染（防误判）',
    content: '预算是 $5 和 $10 的区别，不应该变成公式。',
  },
  {
    title: '代码块内不转换',
    content: '```\n\\[ 这里是代码，不渲染 \\]\n```\n\n行内代码 `\\(x\\)` 也不渲染。',
  },
];

export default function MarkdownMathPreviewPage() {
  if (process.env.NODE_ENV === 'production') notFound();

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: 24 }}>
      {SAMPLES.map((sample) => (
        <section key={sample.title} style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 13, opacity: 0.6, marginBottom: 8 }}>{sample.title}</h2>
          <div style={{ border: '1px solid var(--console-border-soft, #444)', borderRadius: 8, padding: 16 }}>
            <MarkdownContent content={sample.content} />
          </div>
        </section>
      ))}
    </main>
  );
}
