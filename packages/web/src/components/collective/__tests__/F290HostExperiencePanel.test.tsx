import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';

import { F290HostExperiencePanel } from '../F290HostExperiencePanel';

it('renders the Café candidate in the Host and only returns a public work reference', () => {
  const html = renderToStaticMarkup(
    <F290HostExperiencePanel
      open
      resultPending={false}
      activeWorkRef="work_demo_product-brief"
      onClose={() => undefined}
      onOpenWork={() => undefined}
      onReturnResult={() => undefined}
    />,
  );

  expect(html).toContain('Host 私密渲染');
  expect(html).toContain('work_demo_product-brief');
  expect(html).toContain('将公开结果带回原 Channel');
  expect(html).not.toContain('thread_private');
  expect(html).not.toContain('endpointCredential');
});

it('explains an unknown Work reference instead of silently dropping the Host action', () => {
  const html = renderToStaticMarkup(
    <F290HostExperiencePanel
      open
      resultPending={false}
      activeWorkRef="work_demo_unknown"
      onClose={() => undefined}
      onOpenWork={() => undefined}
      onReturnResult={() => undefined}
    />,
  );

  expect(html).toContain('这项 Work 已不在当前 Café 的可继续范围内。');
  expect(html).not.toContain('将公开结果带回原 Channel');
});

it('keeps a new private-context proposal actionable without creating a public Task', () => {
  const html = renderToStaticMarkup(
    <F290HostExperiencePanel
      open
      resultPending={false}
      onClose={() => undefined}
      onOpenWork={() => undefined}
      onReturnResult={() => undefined}
    />,
  );

  expect(html).toContain('提出新事项草案');
  expect(html).toContain('没有来源、Work 关系和 owner admission');
  expect(html).not.toContain('thread_private');
});
