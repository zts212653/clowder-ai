import type { CatId, MatterCatalog, MatterCatalogItem } from '@cat-cafe/shared';
import { estimateTokens } from '../../../utils/token-counter.js';
import { ContextSourceWorkBudget } from '../cue/ContextSourceWorkBudget.js';
import type { MatterMemoryService } from './MatterMemoryService.js';
import { matterCatalogCursor } from './matter-catalog-cursor.js';

const budget = { encoding: 'o200k_base', summaryTokensPerPage: 1024, directoryTokens: 3072 } as const;
type OpeningItem = Pick<MatterCatalogItem, 'matterId' | 'title' | 'revision' | 'entryCount' | 'summaryStatus'> & {
  threadSource?: '含本线程来源';
  contextHint?: string;
};
function render(items: OpeningItem[], nextCursor?: string): string {
  return [
    '[事情目录]',
    '以下是当前有权读取的事情线索，不是原话、决定或执行授权；目录和语境线索均不表示已读。',
    '“含本线程来源”只表示原话出处，不证明适用本线程。语境线索是该页版本的整段猫的归纳，保留其适用/不适用范围；装不下则只给读入口，不截断。来源已变的归纳未经复核，不作现行结论。',
    '本轮相关页仍须调用 cat_cafe_read_memory_matter 读完整归纳与原话，核范围和当前版本；即使上轮读过也要重读。当前用户新指令按其范围优先，历史解释不新增授权。',
    '找更多页用 cat_cafe_list_memory_matters(query 或 cursor)。新原话/更正用 cat_cafe_remember（target matter）；人物/画像/品味也走 cat_cafe_remember 的对应 target，仍各自审批。',
    JSON.stringify({ budget, items, ...(nextCursor ? { nextCursor } : {}) }),
    '[/事情目录]',
  ].join('\n');
}

export async function matterOpeningDirectory(
  service: Pick<MatterMemoryService, 'catalog'>,
  userId: string,
  catId: CatId,
  threadId?: string,
): Promise<string> {
  const actor = { userId, viewer: { type: 'cat' as const, catId } };
  const options = { threadId };
  let catalog: MatterCatalog;
  try {
    catalog = await new ContextSourceWorkBudget().run((signal) =>
      service.catalog(actor, { ...options, limit: 12, signal }),
    );
  } catch {
    return '[事情目录]\n当前目录不可用；需要时调用 cat_cafe_list_memory_matters 重读。目录失败不阻挡本轮工作。\n[/事情目录]';
  }
  const pages = catalog.items.filter((item): item is MatterCatalogItem => !('unavailable' in item));
  const items: OpeningItem[] = [];
  let nextCursor = catalog.nextCursor;
  for (const [index, page] of pages.entries()) {
    const item: OpeningItem = {
      matterId: page.matterId,
      title: page.title,
      revision: page.revision,
      entryCount: page.entryCount,
      ...(page.hasThreadSource ? { threadSource: '含本线程来源' } : {}),
      ...(page.summaryStatus ? { summaryStatus: page.summaryStatus } : {}),
    };
    const continuation =
      index < pages.length - 1 || catalog.nextCursor
        ? matterCatalogCursor(actor, options, {
            matterId: page.matterId,
            updatedAt: page.updatedAt,
            related: page.hasThreadSource === true,
          })
        : undefined;
    if (estimateTokens(render([...items, item], continuation)) > budget.directoryTokens) break;
    items.push(item);
    nextCursor = continuation;
  }
  // Enrich only after reserving the entire visible directory and its real continuation pointer.
  for (const [index, item] of items.entries()) {
    const page = pages[index]!;
    if (!page.hasThreadSource || page.summaryStatus || !page.description.trim()) continue;
    if (estimateTokens(page.description) > budget.summaryTokensPerPage) continue;
    item.contextHint = page.description;
    if (estimateTokens(render(items, nextCursor)) > budget.directoryTokens) delete item.contextHint;
  }
  return render(items, nextCursor);
}
