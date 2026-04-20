/**
 * F162 Phase B: Lark/Feishu CLI type definitions.
 *
 * lark-cli is a Go-based CLI (@larksuite/cli). Output is raw JSON.
 *
 * Envelope (observed 2026-04-17 against v1.x user-token flow):
 *   success: { ok: true,  identity: "user"|"bot", data: { ... } }
 *   failure: { ok: false, identity: "user"|"bot", error: { type, code, message, hint } }
 *
 * The CLI itself always exits 0; successful vs failed API calls are distinguished
 * solely by the `ok` field in the JSON envelope.
 *
 * NOTE: lark-cli returns *flattened* fields under `data` (e.g. `doc_id`, `doc_url`),
 * not the Lark Open API nested shape (`document.document_id`). Keep types aligned
 * with the CLI's output — that's what we actually consume.
 */

/** Error detail included when ok=false */
export interface LarkCliErrorDetail {
  type: string;
  code: number;
  message: string;
  hint?: string;
}

/** Base envelope from lark-cli */
export interface LarkBaseResponse {
  ok: boolean;
  identity?: 'user' | 'bot';
  data?: unknown;
  error?: LarkCliErrorDetail;
}

/** lark-cli docs +create */
export interface LarkDocsCreateResponse extends LarkBaseResponse {
  data?: {
    doc_id: string;
    doc_url: string;
    log_id?: string;
    message?: string;
  };
}

/** lark-cli base +base-create */
export interface LarkBaseCreateResponse extends LarkBaseResponse {
  data?: {
    base?: {
      base_token: string;
      name: string;
      url: string;
      folder_token?: string;
    };
    created?: boolean;
  };
}

/** lark-cli task +create */
export interface LarkTaskCreateResponse extends LarkBaseResponse {
  data?: {
    guid: string;
    url?: string;
  };
}

/** lark-cli calendar +create */
export interface LarkCalendarCreateResponse extends LarkBaseResponse {
  data?: {
    event_id: string;
    summary?: string;
    start?: string;
    end?: string;
  };
}

/** lark-cli slides +create */
export interface LarkSlidesCreateResponse extends LarkBaseResponse {
  data?: {
    xml_presentation_id: string;
    title?: string;
    url?: string;
    revision_id?: number;
  };
}

/** lark-cli contact +search-user (shape best-effort; gated by tenant scope) */
export interface LarkContactSearchResponse extends LarkBaseResponse {
  data?: {
    users?: Array<{
      open_id: string;
      name: string;
      email?: string;
      user_id?: string;
    }>;
  };
}

// --- Resource Handles (returned by LarkActionService) ---

export interface LarkDocHandle {
  documentId: string;
  url: string;
  title: string;
}

export interface LarkBaseHandle {
  appToken: string;
  url: string;
  name: string;
}

export interface LarkTaskHandle {
  guid: string;
  summary: string;
  url?: string;
}

export interface LarkCalendarEventHandle {
  eventId: string;
  calendarId: string;
  summary: string;
}

export interface LarkSlideHandle {
  presentationId: string;
  url: string;
  title: string;
}

export interface LarkGoldenChainResult {
  doc: LarkDocHandle;
  base: LarkBaseHandle;
  tasks: LarkTaskHandle[];
  calendarEvent: LarkCalendarEventHandle;
  summary: string;
}
