import probe from './probe.config';
export default {
  ...probe,
  test: { ...probe.test, include: ['src/components/__tests__/section-group-path-tooltip.test.tsx'] },
};
