import { useCollectiveLanguage } from './collective-copy.js';

const en: Record<string, string> = {
  预览所选原件版本: 'Preview selected original version',
  共同体成员: 'Collective member',
  更多作品: 'More works',
  最新版暂时不可确认: 'The latest readable version is unconfirmed',
  本项目用的版本: 'Version used by this project',
  '引用作品…': 'Reference a work…',
  引用作品: 'Reference a work',
  '本项目引用的是原作品的明确版本。新版只提示，换用只改本项目。':
    'This project references one exact original version. New versions notify you; switching affects only this project.',
  这件作品现在打不开: 'This work is currently unavailable',
  '原件撤回了，或你没有权限了。': 'The original was withdrawn or you no longer have access.',
  '内容所在的 Café 暂时不可用。': 'The content owner’s Café is temporarily unavailable.',
  打开本项目用的: 'Open this project’s',
  有新版: 'New version',
  '换用…': 'Switch version…',
  保持: 'Keep',
  '移出…': 'Remove…',
  版本与动态: 'Versions and activity',
  '由项目负责人决定换不换。': 'The project owner decides whether to switch.',
  '保持当前版本，以后仍可换用。': 'Keeping the current version. You can still switch later.',
  '还没有引用作品。': 'No work referenced yet.',
  '项目引用暂时不可读，请重新读取。': 'Project references are temporarily unavailable. Please reload.',
  重新读取: 'Reload',
  作品: 'Work',
  项目作品: 'Project works',
  '正在读取作品…': 'Reading project works…',
  '你无权读取这个项目的作品。': 'You do not have access to this project’s works.',
  '暂时读不到这个项目的作品，请稍后重试。': 'This project’s works are temporarily unavailable. Please try again.',
  换用作品版本: 'Switch the referenced version',
  从项目移出作品: 'Remove work from project',
  现在用: 'Currently using',
  换成: 'Switch to',
  选择版本: 'Choose a version',
  先不换: 'Cancel',
  取消: 'Cancel',
  引用: 'Reference',
  换用: 'Switch to',
  移出: 'Remove',
  当前可读最新版: 'Latest readable version',
  并排比较这两版: 'Compare these versions',
  '只改这个项目，其他项目与原件、旧版都不变。':
    'Only this project changes. Other projects, the original and earlier versions remain unchanged.',
  '移出只解除本项目的引用，不删除原件或其他项目的引用。':
    'Removing only releases this project’s reference. The original and other projects remain intact.',
  '合并内容请回原讨论，请保管人出候选，再批注和采用。':
    'To merge content, return to the original discussion and ask the custodian for a candidate, then review and adopt it.',
  返回原讨论: 'Original discussion',
  '没有可引用的作品。': 'No readable work is available.',
  '正在读取版本记录…': 'Reading version history…',
  更早的版本: 'Earlier versions',
  未提供改动说明: 'No change description provided',
  分享的版本: 'Published version',
  采用了修改: 'Adopted changes',
  '这处引用刚被改过，已显示现在实际使用的版本；请重新选择。':
    'This reference just changed. The actual current version is shown; choose again.',
  '操作尚未确认，请重试。': 'The operation is unconfirmed. Please retry.',
  动态: 'Activity',
  还未选择本项目版本: 'No project version selected yet',
};
export function useProjectArtifactText() {
  const language = useCollectiveLanguage();
  return (text: string) => (language === 'en' ? (en[text] ?? text) : text);
}
