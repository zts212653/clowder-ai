export interface WeChatVisibleReaderArmStatus {
  armed: boolean;
  remainingMs: number;
  armedBy?: string;
  armedAt?: string;
  expiresAt?: string;
}

interface ArmState {
  operator: string;
  armedAt: number;
  expiresAt: number;
}

export interface WeChatVisibleReaderArmStoreOptions {
  now?: () => number;
}

export class WeChatVisibleReaderArmStore {
  private readonly now: () => number;
  private current: ArmState | null = null;

  constructor(options: WeChatVisibleReaderArmStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  arm(input: { operator: string; minutes: number }): WeChatVisibleReaderArmStatus {
    if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 30) {
      throw new RangeError('Arm TTL must be a whole number between 1 and 30 minutes');
    }
    const operator = input.operator.trim();
    if (!operator) {
      throw new Error('Arm operator is required');
    }

    const armedAt = this.now();
    this.current = {
      operator,
      armedAt,
      expiresAt: armedAt + input.minutes * 60_000,
    };
    return this.status();
  }

  status(): WeChatVisibleReaderArmStatus {
    if (!this.current) return { armed: false, remainingMs: 0 };
    const remainingMs = this.current.expiresAt - this.now();
    if (remainingMs <= 0) {
      this.current = null;
      return { armed: false, remainingMs: 0 };
    }
    return {
      armed: true,
      remainingMs,
      armedBy: this.current.operator,
      armedAt: new Date(this.current.armedAt).toISOString(),
      expiresAt: new Date(this.current.expiresAt).toISOString(),
    };
  }

  isArmed(): boolean {
    return this.status().armed;
  }

  disarm(): WeChatVisibleReaderArmStatus {
    this.current = null;
    return { armed: false, remainingMs: 0 };
  }
}
