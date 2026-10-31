/**
 * Tests for cafe/no-hardcoded-colors ESLint rule
 */
const { RuleTester } = require('eslint');
const rule = require('./no-hardcoded-colors');

const tester = new RuleTester({
  parserOptions: {
    ecmaVersion: 2020,
    ecmaFeatures: { jsx: true },
    sourceType: 'module',
  },
});

tester.run('no-hardcoded-colors', rule, {
  valid: [
    // Semantic cat tokens are allowed
    { code: '<div className="bg-opus-primary text-codex-dark" />' },
    { code: '<div className="border-gemini-light bg-codex-bg" />' },
    // Cafe tokens are allowed
    { code: '<div className="bg-cafe-white text-cafe-black" />' },
    // Werewolf tokens are allowed
    { code: '<div className="bg-ww-base text-ww-main border-ww-subtle" />' },
    // Non-color Tailwind classes are fine
    { code: '<div className="flex items-center gap-2 rounded-lg p-4" />' },
    // CSS variables in style props are fine
    { code: '<div style={{ color: "var(--cafe-text)" }} />' },
    // F056 Phase E: OKLCH via CSS var is fine
    { code: '<div className="bg-neutral-50 text-accent-500 border-semantic-warning" />' },
    { code: '<div className="bg-chart-3 text-avatar-fallback-5" />' },
    { code: '<div style={{ color: "var(--semantic-critical)" }} />' },
    // Non-JSX strings with colors (not in className/style)
    { code: 'const hex = "#FF0000";' },
  ],

  invalid: [
    // Raw Tailwind neutrals
    {
      code: '<div className="bg-white" />',
      errors: [{ messageId: 'noRawTailwindColor' }],
    },
    {
      code: '<div className="text-gray-700" />',
      errors: [{ messageId: 'noRawTailwindColor' }],
    },
    {
      code: '<div className="border-gray-200 bg-gray-50" />',
      errors: [{ messageId: 'noRawTailwindColor' }, { messageId: 'noRawTailwindColor' }],
    },
    // Raw Tailwind colors
    {
      code: '<div className="bg-red-500" />',
      errors: [{ messageId: 'noRawTailwindColor' }],
    },
    {
      code: '<div className="text-blue-600" />',
      errors: [{ messageId: 'noRawTailwindColor' }],
    },
    // Arbitrary color values
    {
      code: '<div className="bg-[#FF0000]" />',
      errors: [{ messageId: 'noArbitraryColor' }],
    },
    // Hex in style props
    {
      code: '<div style={{ color: "#FF0000" }} />',
      errors: [{ messageId: 'noHexInStyle' }],
    },
    {
      code: '<div style={{ backgroundColor: "#1a1a2e" }} />',
      errors: [{ messageId: 'noHexInStyle' }],
    },
    // Template literal in className
    {
      code: '<div className={`bg-white ${cond}`} />',
      errors: [{ messageId: 'noRawTailwindColor' }],
    },
    // Multiple issues in one element
    {
      code: '<div className="bg-white text-gray-700 border-red-500" />',
      errors: [
        { messageId: 'noRawTailwindColor' },
        { messageId: 'noRawTailwindColor' },
        { messageId: 'noRawTailwindColor' },
      ],
    },
    // P1: Conditional expression branches
    {
      code: '<div className={x ? "bg-white" : "bg-black"} />',
      errors: [{ messageId: 'noRawTailwindColor' }, { messageId: 'noRawTailwindColor' }],
    },
    // P1: Logical expression
    {
      code: '<div className={active && "bg-amber-200"} />',
      errors: [{ messageId: 'noRawTailwindColor' }],
    },
    // P1: cn()/clsx() call arguments
    {
      code: '<div className={cn("bg-white", "text-gray-700")} />',
      errors: [{ messageId: 'noRawTailwindColor' }, { messageId: 'noRawTailwindColor' }],
    },
    // P1: Nested ternary inside cn()
    {
      code: '<div className={cn(active ? "bg-red-500" : "bg-blue-500")} />',
      errors: [{ messageId: 'noRawTailwindColor' }, { messageId: 'noRawTailwindColor' }],
    },
    // P1: Template literal inside ternary
    {
      code: '<div className={x ? `bg-white ${y}` : "bg-black"} />',
      errors: [{ messageId: 'noRawTailwindColor' }, { messageId: 'noRawTailwindColor' }],
    },
    // F056 Phase E AC-E11: arbitrary oklch() in className
    {
      code: '<div className="bg-[oklch(0.5_0.15_30)]" />',
      errors: [{ messageId: 'noArbitraryOklch' }],
    },
    {
      code: '<div className="text-[oklch(0.62_0.13_297)]" />',
      errors: [{ messageId: 'noArbitraryOklch' }],
    },
    // F056 Phase E AC-E11: inline oklch() literal in style props
    {
      code: '<div style={{ color: "oklch(0.5 0.15 30)" }} />',
      errors: [{ messageId: 'noOklchInStyle' }],
    },
    {
      code: '<div style={{ backgroundColor: "oklch(0.18 0.005 30)" }} />',
      errors: [{ messageId: 'noOklchInStyle' }],
    },
    // 砚砚 round-5 P2: arbitrary rgba/hsl in Tailwind utility brackets
    {
      code: '<div className="shadow-[0_5px_14px_rgba(43,37,32,0.07)]" />',
      errors: [{ messageId: 'noArbitraryRawColorFn' }],
    },
    {
      code: '<div className="shadow-[0_1px_3px_rgba(43,33,26,0.06)]" />',
      errors: [{ messageId: 'noArbitraryRawColorFn' }],
    },
    {
      code: '<div className="bg-[hsl(0,0%,50%)]" />',
      errors: [{ messageId: 'noArbitraryRawColorFn' }],
    },
  ],
});

console.log('✅ All no-hardcoded-colors tests passed');
