import base from '../vitest.config';
export default {
  ...base,
  plugins: [{
    name: 'review-only-short-path-counterexample',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      if (!process.env.PR1663_RESTORE_TOOLTIP_BUG || !id.replaceAll('\\', '/').split('?')[0].endsWith('/ThreadSidebar/SectionGroup.tsx')) return;
      const fixed = "onlyWhenTruncated={!projectPath || projectPath === 'default'}";
      if (!code.includes(fixed)) throw new Error('Review fault not applied: tooltip expression moved');
      return code.replace(fixed, 'onlyWhenTruncated');
    },
  }],
  test: { ...base.test, include: ['.review-pr1663-tooltip/short-path.test.tsx'] },
};
