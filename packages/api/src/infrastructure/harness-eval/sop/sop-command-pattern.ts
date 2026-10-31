export function matchesCommandPattern(command: string, expression: string): boolean {
  return new RegExp(expression).test(command);
}
