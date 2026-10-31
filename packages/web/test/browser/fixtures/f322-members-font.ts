// Next transforms localFont at build time. The inactive leaderboard is imported by
// SettingsContent; this Vite fixture keeps that compiler boundary outside the test.
export default function localFont() {
  return { className: '', variable: '', style: { fontFamily: 'inherit' } };
}
