const S = {
  h1: 'font-size:22px;font-weight:bold;margin:20px 0 10px;color:#333;',
  h2: 'font-size:20px;font-weight:bold;margin:18px 0 8px;color:#333;',
  h3: 'font-size:18px;font-weight:bold;margin:16px 0 6px;color:#333;',
  p: 'margin:8px 0;line-height:1.8;color:#333;font-size:15px;',
  code: 'background:#f5f5f5;padding:2px 6px;border-radius:3px;font-size:13px;font-family:monospace;color:#e74c3c;',
  pre: 'background:#f5f5f5;padding:12px 16px;border-radius:6px;overflow-x:auto;margin:12px 0;line-height:1.6;font-size:13px;font-family:monospace;color:#333;',
  blockquote: 'border-left:4px solid #ddd;padding:8px 16px;margin:12px 0;color:#666;background:#fafafa;',
  hr: 'border:none;border-top:1px solid #ddd;margin:20px 0;',
  ul: 'padding-left:24px;margin:8px 0;',
  ol: 'padding-left:24px;margin:8px 0;',
  li: 'margin:4px 0;line-height:1.8;font-size:15px;color:#333;',
  img: 'max-width:100%;height:auto;margin:12px 0;border-radius:4px;',
  a: 'color:#576b95;text-decoration:none;',
  table: 'border-collapse:collapse;width:100%;margin:12px 0;font-size:14px;',
  th: 'border:1px solid #ddd;padding:8px 12px;background:#f5f5f5;font-weight:bold;text-align:left;',
  td: 'border:1px solid #ddd;padding:8px 12px;',
} as const;

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function processInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, `<img src="$2" alt="$1" style="${S.img}" />`)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, `<a href="$2" style="${S.a}">$1</a>`)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, `<code style="${S.code}">$1</code>`);
}

export function markdownToWxHtml(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.startsWith('```')) {
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        codeLines.push(escapeHtml(lines[i]!));
        i++;
      }
      i++;
      out.push(`<pre style="${S.pre}">${codeLines.join('\n')}</pre>`);
      continue;
    }

    if (/^\|.+\|$/.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && /^\|.+\|$/.test(lines[i]!)) {
        const row = lines[i]!;
        i++;
        if (/^\|[\s-:|]+\|$/.test(row)) continue;
        const cells = row
          .split('|')
          .slice(1, -1)
          .map((c) => c.trim());
        const isHeader = rows.length === 0;
        const tag = isHeader ? 'th' : 'td';
        const style = isHeader ? S.th : S.td;
        rows.push(`<tr>${cells.map((c) => `<${tag} style="${style}">${processInline(c)}</${tag}>`).join('')}</tr>`);
      }
      out.push(`<table style="${S.table}">${rows.join('')}</table>`);
      continue;
    }

    if (line === '') {
      i++;
      continue;
    }
    if (line === '---' || line === '***') {
      out.push(`<hr style="${S.hr}" />`);
      i++;
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)/);
    if (headingMatch) {
      const level = headingMatch[1]!.length as 1 | 2 | 3;
      const tag = `h${level}` as const;
      out.push(`<${tag} style="${S[tag]}">${processInline(headingMatch[2]!)}</${tag}>`);
      i++;
      continue;
    }

    if (line.startsWith('> ')) {
      const bqLines: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('> ')) {
        bqLines.push(lines[i]!.slice(2));
        i++;
      }
      out.push(
        `<blockquote style="${S.blockquote}">${bqLines.map((l) => `<p style="${S.p}">${processInline(l)}</p>`).join('')}</blockquote>`,
      );
      continue;
    }

    if (/^[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i]!)) {
        items.push(`<li style="${S.li}">${processInline(lines[i]!.slice(2))}</li>`);
        i++;
      }
      out.push(`<ul style="${S.ul}">${items.join('')}</ul>`);
      continue;
    }

    if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i]!)) {
        items.push(`<li style="${S.li}">${processInline(lines[i]!.replace(/^\d+\.\s/, ''))}</li>`);
        i++;
      }
      out.push(`<ol style="${S.ol}">${items.join('')}</ol>`);
      continue;
    }

    out.push(`<p style="${S.p}">${processInline(line)}</p>`);
    i++;
  }

  return out.join('\n');
}
