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
    { code: '<div className="border-gemini-light bg-dare-bg" />' },
    // Cafe tokens are allowed
    { code: '<div className="bg-cafe-white text-cafe-black" />' },
    // Werewolf tokens are allowed
    { code: '<div className="bg-ww-base text-ww-main border-ww-subtle" />' },
    // Non-color Tailwind classes are fine
    { code: '<div className="flex items-center gap-2 rounded-lg p-4" />' },
    // CSS variables in style props are fine
    { code: '<div style={{ color: "var(--cafe-text)" }} />' },
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
  ],
});

console.log('✅ All no-hardcoded-colors tests passed');
