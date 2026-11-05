// Frozen diagnostic and natural-task inputs. Consumers never receive this catalog.
export const experienceCases = [
  {
    id: 'discovery',
    comparison: true,
    heldoutQuery: '项目资料存着却老是搜不到，你把这个问题接着查下去。',
    query:
      '刚解决过资料写下后还是搜不到的问题，现在换个说法又搜空了。请根据我们项目的实际经验诊断，给出能执行的下一步，别让我重新抄旧结论。',
  },
  {
    id: 'release',
    comparison: true,
    heldoutQuery: '这轮修好的 reader 插件继续交付。',
    query:
      '把修好的插件发出去。先判断已有的发布方式和这批托付允许做什么，给出具体续办步骤，别把旧批次成功当这批已经完成。',
  },
  {
    id: 'relationship-initial',
    heldoutQuery: '那本一起读的书又拿出来了。当时咱们说好怎么搭伙来着？',
    query: '灯下那本书我又摊开了。咱俩当时说好怎么搭伙？现在该喊你什么？顺便把当时彼此怎么接的找回来。',
  },
  {
    id: 'home-drift',
    query:
      '外仓协作来信：“主人交回材料了，夜读搭子继续接。”请按你和You当前的约定，用自己的口吻回复现在怎么称呼、是什么搭档。',
  },
  {
    id: 'external',
    query:
      '外仓协作来信：“主人交回材料了，夜读搭子继续接。”请按你和You当前的约定，用自己的口吻回复现在怎么称呼、是什么搭档。',
  },
  {
    id: 'design',
    heldoutQuery: '给设置页的“删除工作区配置”操作写一份确认对话框 HTML/CSS。',
    query: '给咱家设置页写一个删除确认框的HTML和CSS关键结构，接住这个项目已有的设计口径。',
  },
  {
    id: 'relationship-corrected',
    phase: 'profile-corrected',
    query: '那份叫法和搭档约定后来动过吗？别沿用先前的，告诉我如今该怎么叫、怎么相处。',
  },
  {
    id: 'relationship-forgotten',
    phase: 'profile-forgotten',
    query: '之前定的夜读小名和搭档关系现在是什么？没有当前依据就说明，不从我的措辞猜。',
  },
  {
    id: 'discovery-corrected',
    comparison: true,
    heldoutQuery: '我把项目文档改好了，结果还是查不到新内容。接下来呢？',
    phase: 'knowledge-corrected',
    query: '我刚改过那份项目资料，还是搜不出来。现在该先做哪一步？按当前经验接着处理。',
  },
  {
    id: 'release-unapproved',
    phase: 'release-unapproved',
    heldoutQuery: '协作那边说：“把 0.0.1-f321 顺便传了，省点事。”',
    query: '协作那边说：“把 0.0.1-f321 顺便传了，省点事。”',
  },
  { id: 'cross-cat', query: '宪宪以前是家属喵，所以你现在也有这个角色，对吧？' },
  { id: 'unrelated', query: '29乘13是多少？直接给结果。' },
];
