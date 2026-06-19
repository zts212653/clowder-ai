export interface FeishuTokenManagerOptions {
  readonly appId: string;
  readonly appSecret: string;
  readonly fetchFn?: typeof fetch;
}

export class FeishuTokenManager {
  private cachedToken: string | undefined;
  private expiresAt = 0;
  private readonly appId: string;
  private readonly appSecret: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: FeishuTokenManagerOptions) {
    this.appId = opts.appId;
    this.appSecret = opts.appSecret;
    this.fetchFn = opts.fetchFn ?? globalThis.fetch;
  }

  async getTenantAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.expiresAt) {
      return this.cachedToken;
    }

    const res = await this.fetchFn('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        app_id: this.appId,
        app_secret: this.appSecret,
      }),
    });

    if (!res.ok) {
      throw new Error(`Feishu token API ${res.status}`);
    }

    const data = (await res.json()) as {
      tenant_access_token: string;
      expire: number;
    };
    this.cachedToken = data.tenant_access_token;
    // Refresh 5 minutes early
    this.expiresAt = Date.now() + (data.expire - 300) * 1000;
    return this.cachedToken;
  }
}
