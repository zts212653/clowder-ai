import { fileURLToPath, pathToFileURL } from 'node:url';
import { isCredentialSource } from './secret-credential-paths.mjs';
import {
  CURL_FILE_VALUES,
  CURL_FLAGS,
  CURL_FORMS,
  CURL_REFERENCES,
  CURL_VALUES,
  sendArguments,
} from './secret-send-options.mjs';

export async function prepareCurlArgs(args, freeze) {
  const output = ['-q']; // curl only disables implicit .curlrc when this is the first argument.
  for (const argument of sendArguments(args, CURL_VALUES, CURL_FLAGS)) {
    if (argument.kind === 'value') {
      output.push(argument.name, await curlValue(argument.name, argument.value, freeze));
    } else {
      if (argument.kind === 'flag') checkFlag(argument.name);
      output.push(await curlUrl(argument.word, freeze));
    }
  }
  return output;
}

function checkFlag(name) {
  if (name === '--config' || /^-K/.test(name) || name.startsWith('--netrc'))
    throw new Error('secret_send_config_unsupported');
  if (!CURL_FLAGS.has(name)) throw new Error('secret_send_option_unsupported');
}

async function curlValue(name, value, freeze) {
  if (name === '--url') return curlUrl(value, freeze);
  if (CURL_FILE_VALUES.has(name) && name !== '--cookie-jar') return freeze(value);
  if (CURL_REFERENCES.has(name) && value.startsWith('@')) return `@${await freeze(value.slice(1))}`;
  if ((name === '--cookie' || name === '-b') && !value.includes('=')) return freeze(value);
  if (CURL_FORMS.has(name)) return freezeForm(value, freeze);
  if (name === '--data-urlencode' || name === '--url-query') {
    const marker = value.indexOf('@');
    if (marker >= 0 && !value.slice(0, marker).includes('='))
      return `${value.slice(0, marker + 1)}${await freeze(value.slice(marker + 1))}`;
  }
  return value;
}

async function curlUrl(value, freeze) {
  if (!/^file:/i.test(value)) return value;
  const url = new URL(value);
  if (isCredentialSource(url.href)) throw new Error('credential_source_blocked_before_read');
  return pathToFileURL(await freeze(fileURLToPath(url))).href;
}

async function freezeForm(value, freeze) {
  // Quoted names, secondary header files and nested multipart syntax need a full
  // curl form parser. Reject those forms instead of sending uninspected bytes.
  if (/;headers\s*=|["\r\n]|=\(/i.test(value)) throw new Error('secret_send_form_unsupported');
  const match = value.match(/^([^=]+=)([@<])([^;]+)(.*)$/);
  if (!match) return value;
  if (match[3].includes(',')) throw new Error('secret_send_form_list_unsupported');
  return `${match[1]}${match[2]}${await freeze(match[3])}${match[4]}`;
}
