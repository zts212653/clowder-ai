const TELEGRAM_BOT_TOKEN_PATTERN = /^\d+:[A-Za-z0-9_-]{10,}$/;

export function normalizeTelegramBotToken(token: string | null | undefined): string | null {
  const value = token?.trim();
  if (!value) return null;
  return TELEGRAM_BOT_TOKEN_PATTERN.test(value) ? value : null;
}
