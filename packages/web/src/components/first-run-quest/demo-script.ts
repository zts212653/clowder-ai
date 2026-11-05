import type { DemoScene } from './onboarding-journey';
export const DEMO_SCENES: Record<
  DemoScene,
  { title: string; body: string; draft?: string; review?: string; improved?: string }
> = {
  opening: { title: '三只猫先认识彼此', body: '规划猫、实现猫和审查猫会用同一件事演示协作。' },
  draft: { title: '规划猫写出初稿', body: '它先把目标拆成可执行的方案。', draft: '把新用户带到第一次真实对话。' },
  review: {
    title: '审查猫找出术语',
    body: '审查猫指出新人不应被内部术语挡住。',
    review: 'handoff 对新人来说太抽象，需要说清楚下一步。',
  },
  improved: {
    title: '实现猫改成更好的结果',
    body: '同伴的反馈让结果更容易理解，也更能直接行动。',
    draft: '把新用户带到第一次真实对话。',
    review: '去掉内部术语，补上明确的下一步。',
    improved: '先看团队如何协作，再按本机可用客户端创建你的真实伙伴。',
  },
  handoff: { title: '刚才是示范', body: '从这里开始，解说猫会成为你的第一位真实伙伴。' },
};
export function nextDemoScene(scene: DemoScene): DemoScene {
  return scene === 'opening' ? 'draft' : scene === 'draft' ? 'review' : scene === 'review' ? 'improved' : 'handoff';
}
