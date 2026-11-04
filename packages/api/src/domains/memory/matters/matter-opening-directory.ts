import type { CatId, MatterCatalog } from '@cat-cafe/shared';
import { ContextSourceWorkBudget } from '../cue/ContextSourceWorkBudget.js';
import type { MatterMemoryService } from './MatterMemoryService.js';

export async function matterOpeningDirectory(
  service: Pick<MatterMemoryService, 'catalog'>,
  userId: string,
  catId: CatId,
): Promise<string> {
  let catalog: MatterCatalog;
  try {
    catalog = await new ContextSourceWorkBudget().run((signal) =>
      service.catalog({ userId, viewer: { type: 'cat', catId } }, { limit: 12, signal }),
    );
  } catch {
    return '[事情目录]\n当前目录不可用；需要时调用 cat_cafe_list_memory_matters 重读。目录失败不阻挡本轮工作。\n[/事情目录]';
  }
  return [
    '[事情目录]',
    '以下是当前有权读取的跨线事情索引。标题是猫整理的线索，不是原话、决定或执行授权；此目录不表示已读。',
    '按本轮相关性选择 cat_cafe_read_memory_matter 回读原话；即使上轮读过，也须重读当前版本。',
    '找更多页用 cat_cafe_list_memory_matters(query 或 cursor)。有新原话/更正时用 cat_cafe_write_memory_matter 关联原始消息，人物/画像/品味仍走各自提案。',
    JSON.stringify({
      items: catalog.items.map((item) =>
        'unavailable' in item
          ? null
          : { matterId: item.matterId, title: item.title, revision: item.revision, entryCount: item.entryCount },
      ),
      ...(catalog.nextCursor ? { nextCursor: catalog.nextCursor } : {}),
    }),
    '[/事情目录]',
  ].join('\n');
}
