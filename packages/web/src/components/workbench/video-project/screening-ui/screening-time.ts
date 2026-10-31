/** Film clocks share m:ss; artwork locations retain one decimal to identify an actual appearance. */
export function screeningTime(seconds: number, precise = false) {
  const value = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const tenths = Math.floor(value * 10);
  const minutes = Math.floor(tenths / 600);
  const rest = Math.floor((tenths % 600) / 10)
    .toString()
    .padStart(2, '0');
  return `${minutes}:${rest}${precise ? `.${tenths % 10}` : ''}`;
}
