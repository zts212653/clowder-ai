import type { SignalArticle } from '@cat-cafe/shared';

export interface DailyDigestEmailInput {
  readonly date: string;
  readonly articles: readonly SignalArticle[];
}

export interface DailyDigestEmailContent {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function groupByTier(articles: readonly SignalArticle[]): Map<number, SignalArticle[]> {
  const grouped = new Map<number, SignalArticle[]>();

  for (const article of articles) {
    const list = grouped.get(article.tier) ?? [];
    list.push(article);
    grouped.set(article.tier, list);
  }

  for (const [, list] of grouped) {
    list.sort((a, b) => {
      if (a.source === b.source) return a.title.localeCompare(b.title);
      return a.source.localeCompare(b.source);
    });
  }

  return grouped;
}

function renderEmptyHtml(date: string): string {
  return `<h1>🐱 Clowder AI 信号日报 - ${escapeHtml(date)}</h1><p>今日无新增信号，咱们继续观察。</p>`;
}

function renderEmptyText(date: string): string {
  return `🐱 Clowder AI 信号日报 - ${date}\n\n今日无新增信号，咱们继续观察。`;
}

function renderTierHtml(tier: number, articles: readonly SignalArticle[]): string {
  const items = articles
    .map((article) => {
      const summary = article.summary ? `<p>${escapeHtml(article.summary)}</p>` : '';
      return `<li><a href="${escapeHtml(article.url)}">${escapeHtml(article.title)}</a> · ${escapeHtml(article.source)}${summary}</li>`;
    })
    .join('');

  return `<section><h2>Tier ${tier}</h2><ul>${items}</ul></section>`;
}

function renderTierText(tier: number, articles: readonly SignalArticle[]): string {
  const lines = [`Tier ${tier}`];

  for (const article of articles) {
    lines.push(`- ${article.title} (${article.source})`);
    lines.push(`  ${article.url}`);
    if (article.summary) {
      lines.push(`  ${article.summary}`);
    }
  }

  return lines.join('\n');
}

export function renderDailyDigestEmail(input: DailyDigestEmailInput): DailyDigestEmailContent {
  const subject = `🐱 Clowder AI 信号日报 - ${input.date}`;

  if (input.articles.length === 0) {
    return {
      subject,
      html: renderEmptyHtml(input.date),
      text: renderEmptyText(input.date),
    };
  }

  const grouped = groupByTier(input.articles);
  const tiers = Array.from(grouped.keys()).sort((a, b) => a - b);

  const htmlSections = tiers.map((tier) => renderTierHtml(tier, grouped.get(tier) ?? [])).join('');
  const textSections = tiers.map((tier) => renderTierText(tier, grouped.get(tier) ?? [])).join('\n\n');

  return {
    subject,
    html: `<h1>🐱 Clowder AI 信号日报 - ${escapeHtml(input.date)}</h1>${htmlSections}`,
    text: `🐱 Clowder AI 信号日报 - ${input.date}\n\n${textSections}`,
  };
}
