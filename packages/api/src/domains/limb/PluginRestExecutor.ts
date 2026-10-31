import type { LimbInvokeResult } from '@cat-cafe/shared';
import type { LimbCommandDef, LimbErrorConfig } from './limb-yaml-loader.js';
import type { PluginTokenManager } from './PluginTokenManager.js';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Generic REST executor — builds and executes HTTP requests
 * from YAML command definitions.
 */
export class PluginRestExecutor {
  constructor(
    private readonly baseUrl: string,
    private readonly tokenManager: PluginTokenManager,
    private readonly errorConfig: LimbErrorConfig | undefined,
    private readonly tokenPlacement: 'query' | 'header',
    private readonly tokenParamName: string,
  ) {}

  async execute(commandDef: LimbCommandDef, params: Record<string, unknown>): Promise<LimbInvokeResult> {
    const resolvedParams = this.applyDefaults(commandDef, params);
    const body = commandDef.body ? this.resolveBodyTemplate(commandDef.body, resolvedParams) : undefined;
    const url = `${this.baseUrl}${commandDef.endpoint}`;
    const method = commandDef.method?.toUpperCase() ?? 'POST';

    return this.executeWithTokenRetry(url, method, body);
  }

  private async executeWithTokenRetry(url: string, method: string, body: unknown): Promise<LimbInvokeResult> {
    try {
      return await this.doRequest(url, method, body);
    } catch (err) {
      if (err instanceof RestApiError && this.tokenManager.isTokenExpiredError(err.errcode)) {
        await this.tokenManager.invalidateAccessToken();
        return this.doRequest(url, method, body);
      }
      throw err;
    }
  }

  private async doRequest(url: string, method: string, body: unknown): Promise<LimbInvokeResult> {
    const token = await this.tokenManager.getAccessToken();
    const fullUrl = this.injectToken(url, token);
    const headers = this.buildHeaders(token);

    const res = await fetch(fullUrl, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!res.ok) {
      throw new Error(`API request failed: HTTP ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as Record<string, unknown>;
    this.checkResponseError(data);
    return { success: true, data };
  }

  private injectToken(url: string, token: string): string {
    if (this.tokenPlacement === 'header') return url;
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}${this.tokenParamName}=${encodeURIComponent(token)}`;
  }

  private buildHeaders(token: string): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.tokenPlacement === 'header') headers[this.tokenParamName] = token;
    return headers;
  }

  private checkResponseError(data: Record<string, unknown>): void {
    if (!this.errorConfig) return;
    const code = data[this.errorConfig.codePath] as number | undefined;
    if (code && code !== 0) {
      const msg = (data[this.errorConfig.messagePath] as string) ?? '';
      throw new RestApiError(code, msg);
    }
  }

  private applyDefaults(commandDef: LimbCommandDef, params: Record<string, unknown>): Record<string, unknown> {
    const result = { ...params };
    for (const [key, schema] of Object.entries(commandDef.params)) {
      if (result[key] === undefined && schema.default !== undefined) {
        result[key] = schema.default;
      }
    }
    return result;
  }

  /** Recursively resolve ${params.xxx} in body template */
  resolveBodyTemplate(template: unknown, params: Record<string, unknown>): unknown {
    if (typeof template === 'string') {
      const match = /^\$\{params\.(\w+)\}$/.exec(template);
      if (match) return params[match[1]];
      return template.replace(/\$\{params\.(\w+)\}/g, (_, key: string) => String(params[key] ?? ''));
    }
    if (Array.isArray(template)) {
      return template.map((item) => this.resolveBodyTemplate(item, params));
    }
    if (template && typeof template === 'object') {
      const result: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(template as Record<string, unknown>)) {
        const resolved = this.resolveBodyTemplate(val, params);
        if (resolved !== undefined && resolved !== '') result[key] = resolved;
      }
      return result;
    }
    return template;
  }
}

class RestApiError extends Error {
  constructor(
    readonly errcode: number,
    readonly errmsg: string,
  ) {
    super(`REST API error: ${errcode} ${errmsg}`);
    this.name = 'RestApiError';
  }
}
