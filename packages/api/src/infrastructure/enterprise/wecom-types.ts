/**
 * F162: WeChat Work (企业微信) CLI type definitions.
 *
 * All wecom-cli responses share a base shape: { errcode, errmsg, ...data }.
 * errcode === 0 means success; anything else is an API error from WeChat Work backend.
 */

/** Base response from wecom-cli commands */
export interface WeComBaseResponse {
  errcode: number;
  errmsg: string;
}

/** wecom-cli doc create_doc response */
export interface WeComDocResponse extends WeComBaseResponse {
  url: string;
  docid: string;
}

/** wecom-cli todo create_todo response */
export interface WeComTodoResponse extends WeComBaseResponse {
  todo_id: string;
}

/** wecom-cli meeting create_meeting response */
export interface WeComMeetingResponse extends WeComBaseResponse {
  meetingid: string;
  meeting_code: string;
  meeting_link: string;
}

/** wecom-cli doc smartsheet_get_sheet response */
export interface WeComSmartTableSheetResponse extends WeComBaseResponse {
  sheet_list: Array<{ sheet_id: string; title: string }>;
}

/** wecom-cli doc smartsheet_get_fields response */
export interface WeComSmartTableGetFieldsResponse extends WeComBaseResponse {
  fields: Array<{ field_id: string; field_title: string; field_type: string }>;
}

/** wecom-cli doc smartsheet_add_fields response */
export interface WeComSmartTableFieldsResponse extends WeComBaseResponse {
  fields: Array<{ field_id: string; field_title: string }>;
}

/** wecom-cli doc smartsheet_add_records response */
export interface WeComSmartTableRecordsResponse extends WeComBaseResponse {
  records: Array<{ record_id: string }>;
}

/** wecom-cli contact get_userlist response */
export interface WeComUserListResponse extends WeComBaseResponse {
  userlist: Array<{ userid: string; name: string; alias?: string }>;
}

// --- Resource Handles (returned by ActionService) ---

export interface DocHandle {
  docId: string;
  url: string;
  docName: string;
}

export interface TodoHandle {
  todoId: string;
  content: string;
}

export interface MeetingHandle {
  meetingId: string;
  meetingCode: string;
  meetingLink: string;
  title: string;
}

export interface GoldenChainResult {
  doc: DocHandle;
  smartTable: DocHandle;
  todos: TodoHandle[];
  meeting: MeetingHandle;
  summary: string;
}
