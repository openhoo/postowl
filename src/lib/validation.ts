import type { RequestDraft } from './types';

export interface KeyValueRowValidationErrors {
  name?: string;
  value?: string;
}

export interface RequestValidationErrors {
  summary?: string;
  name?: string;
  url?: string;
  query?: Record<string, KeyValueRowValidationErrors>;
  headers?: Record<string, KeyValueRowValidationErrors>;
  body?: string;
  preRequestScript?: string;
  postResponseScript?: string;
}

const HTTP_HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const MAX_ROWS = 10_000;
const MAX_NAME_BYTES = 1_024;
const MAX_URL_BYTES = 32_768;
const MAX_TEXT_BYTES = 1_048_576;
const MAX_BODY_BYTES = 16 * 1_048_576;
const MAX_ID_BYTES = 256;
const byteLength = (value: string) => new TextEncoder().encode(value).length;
const validId = (value: string) =>
  value === value.trim() && byteLength(value) >= 1 && byteLength(value) <= MAX_ID_BYTES;

interface TemplateToken {
  start: number;
  end: number;
}

function tokenizeTemplates(value: string): TemplateToken[] | string {
  const tokens: TemplateToken[] = [];
  let offset = 0;
  while (offset < value.length) {
    const start = value.indexOf('{{', offset);
    if (start < 0) break;
    const end = value.indexOf('}}', start + 2);
    if (end < 0) return 'Close every variable expression with }}.';
    if (!value.slice(start + 2, end).trim()) return 'Enter a variable name between {{ and }}.';
    tokens.push({ start, end: end + 2 });
    offset = end + 2;
  }
  return tokens;
}

function renderTemplates(value: string, tokens: TemplateToken[], replacement: (index: number, start: number) => string) {
  let rendered = '';
  let offset = 0;
  tokens.forEach((token, index) => {
    rendered += value.slice(offset, token.start);
    rendered += replacement(index, token.start);
    offset = token.end;
  });
  return rendered + value.slice(offset);
}

function validateRows(
  rows: RequestDraft['query'],
  kind: 'query parameter' | 'header'
): Record<string, KeyValueRowValidationErrors> | undefined {
  const errors: Record<string, KeyValueRowValidationErrors> = {};
  const ids = new Set<string>();
  for (const row of rows) {
    const rowErrors: KeyValueRowValidationErrors = {};
    const name = row.name.trim();
    if (!validId(row.id)) rowErrors.name = `Row ID must be trimmed and contain 1 to ${MAX_ID_BYTES} bytes.`;
    else if (ids.has(row.id)) rowErrors.name = 'Row IDs must be unique.';
    ids.add(row.id);
    if (row.enabled && !name) rowErrors.name = `Enter a ${kind} name.`;
    else if (byteLength(name) > MAX_NAME_BYTES) rowErrors.name = `${kind[0].toUpperCase()}${kind.slice(1)} name exceeds ${MAX_NAME_BYTES} bytes.`;
    else if (kind === 'header' && row.enabled && !HTTP_HEADER_NAME.test(name)) rowErrors.name = 'Use a valid header name.';
    if (byteLength(row.value) > MAX_TEXT_BYTES) rowErrors.value = `${kind[0].toUpperCase()}${kind.slice(1)} value exceeds ${MAX_TEXT_BYTES} bytes.`;
    else if (kind === 'header' && /\r|\n/.test(row.value)) rowErrors.value = 'Remove line breaks from the value.';
    if (rowErrors.name || rowErrors.value) errors[row.id] = rowErrors;
  }
  return Object.keys(errors).length ? errors : undefined;
}

export function validateRequestDraft(draft: RequestDraft): RequestValidationErrors {
  const errors: RequestValidationErrors = {};
  const trimmedName = draft.name.trim();
  if (!trimmedName) errors.name = 'Enter a request name.';
  else if (byteLength(trimmedName) > MAX_NAME_BYTES) errors.name = `Request name exceeds ${MAX_NAME_BYTES} bytes.`;
  if (!validId(draft.id)) errors.summary = `Request ID must be trimmed and contain 1 to ${MAX_ID_BYTES} bytes.`;
  if (draft.collectionId !== null && !validId(draft.collectionId)) {
    errors.summary = `Collection ID must be trimmed and contain 1 to ${MAX_ID_BYTES} bytes.`;
  }
  if (draft.query.length > MAX_ROWS || draft.headers.length > MAX_ROWS) {
    errors.summary = `Requests may contain at most ${MAX_ROWS} query parameters and ${MAX_ROWS} headers.`;
  }

  const requestUrl = draft.url.trim();
  if (!requestUrl) {
    errors.url = 'Enter a request URL.';
  } else if (byteLength(draft.url) > MAX_URL_BYTES) {
    errors.url = `Request URL exceeds ${MAX_URL_BYTES} bytes.`;
  } else {
    const tokens = tokenizeTemplates(requestUrl);
    if (typeof tokens === 'string') {
      errors.url = tokens;
    } else {
      const normalizedUrl = renderTemplates(
        requestUrl,
        tokens,
        (_index, start) => requestUrl.slice(0, start).trim() ? 'postowl' : 'https://example.invalid'
      );
      try {
        const parsedUrl = new URL(normalizedUrl);
        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') errors.url = 'Use an HTTP or HTTPS URL.';
      } catch {
        errors.url = 'Enter a valid HTTP or HTTPS URL.';
      }
    }
  }

  errors.query = validateRows(draft.query, 'query parameter');
  errors.headers = validateRows(draft.headers, 'header');

  if (byteLength(draft.body) > MAX_BODY_BYTES) {
    errors.body = `Request body exceeds ${MAX_BODY_BYTES} bytes.`;
  } else if (draft.bodyMode === 'json') {
    if (!draft.body.trim()) {
      errors.body = 'Enter a JSON body.';
    } else {
      const tokens = tokenizeTemplates(draft.body);
      if (typeof tokens === 'string') {
        errors.body = tokens;
      } else {
        try {
          JSON.parse(renderTemplates(draft.body, tokens, () => 'null'));
        } catch {
          errors.body = 'Enter valid JSON. Variable expressions may replace JSON values or appear inside strings.';
        }
      }
    }
  }

  if (byteLength(draft.preRequestScript) > MAX_TEXT_BYTES) {
    errors.preRequestScript = `Pre-request script exceeds ${MAX_TEXT_BYTES} bytes.`;
  }
  if (byteLength(draft.postResponseScript) > MAX_TEXT_BYTES) {
    errors.postResponseScript = `Post-response script exceeds ${MAX_TEXT_BYTES} bytes.`;
  }
  return errors;
}
