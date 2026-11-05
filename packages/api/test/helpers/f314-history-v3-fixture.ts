export function f314HistoryV3Fixture(archive: Record<string, unknown>) {
  const cases = (structuredClone(archive.cases) as Array<Record<string, unknown>>)
    .slice(0, 2)
    .map((entry, index) => ({ ...entry, caseId: `case-${index}` }));
  return {
    ...structuredClone(archive),
    schemaVersion: 3,
    status: 'source-backed-evolution-story',
    cases,
    story: {
      updated: '2026-10-19',
      overviewMarkdown: '这是一篇由作者完整书写的历史。\n\n- 正文可以有列表\n- 内容发布不要求页面发版',
      sources: [
        {
          id: 'journey',
          label: '真实输入验收修订',
          path: 'docs/VISION.md',
        },
      ],
      steps: [
        {
          stepId: 'complete-result',
          date: '9月19日—10月6日',
          title: '先看整件事是否完成',
          parentEdges: [],
          sourceIds: ['journey'],
          bodyMarkdown:
            '### 我们看见了什么\n\n局部通过不等于完成。\n\n### 我们改了什么\n\n- 把原始托付带回交付判断。\n- [查看依据](https://github.com/zts212653/clowder-ai)\n\n### 仍待确认\n\n真实使用结果仍待观察。',
        },
        {
          stepId: 'real-input',
          date: '2026-10-07',
          title: '用需求方的真实例子验收',
          parentEdges: [
            {
              parentStepId: 'complete-result',
              sourceId: 'journey',
              reason: '沿完整旅程要求，进一步固定真实输入与核心动作。',
            },
          ],
          sourceIds: ['journey'],
          bodyMarkdown:
            '### 我们看见了什么\n\n清单存在不代表内容可读。\n\n### 我们改了什么\n\n1. 打开真实文件。\n2. 核对正文。\n\n### 仍待确认\n\n后续案例仍可能暴露执行遗漏。',
        },
      ],
      cases: [
        {
          caseId: 'case-0',
          stepId: 'complete-result',
          title: '局部通过不是完成',
          sourceIds: ['journey'],
          bodyMarkdown:
            '### 踩了什么坑\n\n局部批准被当成整项完成。\n\n### 当时怎么应对\n\n恢复原始需求。\n\n### 后来怎样\n\n完整交付继续。',
        },
        {
          caseId: 'case-1',
          stepId: 'real-input',
          title: '真实文件必须点得开',
          sourceIds: ['journey'],
          bodyMarkdown:
            '### 踩了什么坑\n\n只列出文件却打不开内容。\n\n### 当时怎么应对\n\n从打开走到读到正文。\n\n### 后来怎样\n\n真实输入要求已经落地。',
        },
      ],
    },
  };
}
