import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { initialState } from '../hub-cat-editor.model';
import { MemberAdditionalFields } from '../settings/members/MemberAdditionalFields';
import { MemberRuntimeFields } from '../settings/members/MemberRuntimeFields';

const t = (zh: string) => zh;
describe('quick member configuration', () => {
  it('offers inheritance as a model choice without a redundant reset or single-account selector', () => {
    const html = renderToStaticMarkup(
      <MemberRuntimeFields
        form={initialState()}
        accounts={[]}
        patch={() => {}}
        t={t}
        accountHref="/settings?s=accounts"
        editing={false}
      />,
    );
    expect(html).toContain('role="combobox"');
    expect(html).toContain('跟随');
    expect(html).not.toContain('模型恢复跟随');
    expect(html).not.toContain('执行身份');
  });
  it('shows meaningful threshold controls and hides compression counts for handoff', () => {
    const html = renderToStaticMarkup(
      <MemberAdditionalFields
        section="context"
        form={initialState()}
        patch={() => {}}
        t={t}
        editing
        strategy={{
          strategy: 'handoff',
          statusStrategy: 'handoff',
          warnThreshold: '0.8',
          actionThreshold: '0.9',
          maxCompressions: '2',
          source: 'test',
          revision: '1',
          changedAt: 0,
          executionStatus: { status: 'unavailable', missingCapabilities: ['managed_invocation_boundary'] },
        }}
        patchStrategy={() => {}}
      />,
    );
    expect(html).toContain('type="range"');
    expect(html).not.toContain('最大压缩次数');
  });
});
