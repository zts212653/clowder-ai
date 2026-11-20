import { prepareCurlArgs } from './secret-curl-args.mjs';
import { prepareGhArgs } from './secret-gh-args.mjs';
import {
  assertSecretFree,
  createPayloadSnapshot,
  readSecretPayload,
  SECRET_PAYLOAD_MAX_BYTES,
} from './secret-payload-files.mjs';
import { assertPlatformSupplementalHeaders, platformCurlAuthentication } from './secret-platform-auth.mjs';

export async function prepareSecretSafeSend(program, args, options = {}) {
  const authentication =
    program === 'curl' ? await platformCurlAuthentication(args) : { scanArgs: args, credentials: [] };
  const check = (content, input) => {
    assertSecretFree(content, input);
    const bytes = Buffer.from(content);
    for (const key of authentication.credentials) {
      const offset = bytes.indexOf(Buffer.from(key));
      if (offset >= 0)
        throw Object.assign(new Error('secret_content_detected'), {
          input,
          finding: { ruleId: 'configured-platform-credential', offset },
        });
    }
  };
  check(authentication.scanArgs.join('\n'), '命令行参数');
  const snapshot = createPayloadSnapshot();
  let stdin;
  let files = 0;
  const freeze = async (path, { headers = false } = {}) => {
    const input = path === '-' ? '标准输入' : `第 ${++files} 个文件输入`;
    const inspect = (content) => {
      check(content, input);
      if (headers && authentication.credentials.length) assertPlatformSupplementalHeaders(content);
    };
    if (path === '-') {
      stdin ??= await (options.readStdin ?? readBoundedStdin)();
      inspect(stdin);
      return snapshot.freeze(stdin);
    }
    const content = readSecretPayload(path, options.cwd, undefined, input);
    inspect(content);
    return snapshot.freeze(content, path);
  };
  try {
    const rewritten =
      program === 'curl'
        ? await prepareCurlArgs(authentication.args ?? args, freeze, authentication.credentials.length > 0)
        : await prepareGhArgs(args, freeze);
    // Admission validated one literal URL. Curl must not expand it into other transfers/paths.
    // Keep -q first; prepareCurlArgs rejects --no-globoff, so callers cannot undo this.
    if (program === 'curl' && authentication.credentials.length) rewritten.splice(1, 0, '--globoff');
    return { args: rewritten, dispose: snapshot.dispose, credentials: authentication.credentials };
  } catch (error) {
    snapshot.dispose();
    throw error;
  }
}

const INPUT_ERRORS = {
  ENOENT: '找不到指定的输入文件（ENOENT）。',
  EACCES: '没有权限读取指定的输入文件（EACCES）。',
  secret_payload_size_limit: '单个输入超出 64 MiB 检查上限。',
  secret_scan_size_limit: '单个输入超出 64 MiB 检查上限。',
  secret_payload_batch_limit: '输入文件数量或总大小超出检查上限。',
  secret_payload_uninspectable: '指定的输入需要是普通文件。',
  secret_payload_changed: '输入文件在检查时发生变化，请重试。',
  credential_source_blocked_before_read: '指定文件是凭据存放处，请改用正文或附件文件。',
  secret_send_argument_missing: '请为指定的参数提供值。',
  secret_send_option_unsupported: '这项参数不能用于受管平台鉴权，请使用显式请求参数。',
  secret_send_implicit_content_unsupported: '发送前无法取得正文，请显式提供正文文件。',
  secret_send_stdin_requires_explicit_content: '请通过文件或管道提供要发送的内容。',
  secret_send_stdin_timeout: '读取要发送的标准输入超时。',
  secret_send_config_unsupported: '无法在发送前检查配置文件引用的内容，请改用显式请求参数。',
  secret_send_form_unsupported: '无法检查这种 multipart 文件输入，请改用显式文件参数。',
  secret_send_form_list_unsupported: '请为每个 multipart 文件单独提供参数。',
  platform_auth_destination_denied: '平台凭据只能用于已登记的服务地址。',
  platform_auth_destination_ambiguous: '平台鉴权需要一个可确认的目标地址。',
};

export function secretSendDiagnostic(error) {
  if (error?.message === 'secret_content_detected') {
    const { ruleId, line, column, offset } = error.finding ?? {};
    const position = line ? `第 ${line} 行第 ${column} 列` : Number.isInteger(offset) ? `第 ${offset + 1} 字节` : '';
    return `secret_send_blocked: 在${error.input ?? '发送内容'}${position}检测到凭据（${ruleId ?? 'credential'}）。`;
  }
  if (error?.message === 'secret_send_generated_pr_body')
    return 'secret_send_input_error: 这条命令会从本地提交自动生成正文，发送前检查不到。请改用 --title 加 --body-file。';
  const code = error?.code ?? error?.message;
  const detail = Object.hasOwn(INPUT_ERRORS, code) ? INPUT_ERRORS[code] : '发送前检查失败，请核对命令和输入文件。';
  return `secret_send_input_error: ${detail}`;
}

async function readBoundedStdin() {
  if (process.stdin.isTTY) throw new Error('secret_send_stdin_requires_explicit_content');
  const parts = [];
  let length = 0;
  const timer = setTimeout(() => process.stdin.destroy(new Error('secret_send_stdin_timeout')), 5000);
  try {
    for await (const chunk of process.stdin) {
      length += chunk.length;
      if (length > SECRET_PAYLOAD_MAX_BYTES) throw new Error('secret_scan_size_limit');
      parts.push(chunk);
    }
    return Buffer.concat(parts);
  } finally {
    clearTimeout(timer);
  }
}
