import { For, Show, createMemo, createSignal } from 'solid-js';
import type { ResponseData } from '../types';
import { formatBytes, statusTone } from '../utils';
import SegmentedControl from './ui/SegmentedControl';
import Tabs from './ui/Tabs';

interface ResponsePanelProps {
  response: ResponseData | null;
  pending?: boolean;
}

type ResponseTab = 'body' | 'headers' | 'assertions' | 'logs';
type PreviewView = 'json' | 'xml' | 'html' | 'image';
type BodyView = 'raw' | PreviewView;

interface BodyPreview {
  view: PreviewView;
  label: string;
  body: string;
  oversized: boolean;
}

const RESPONSE_TABS = ['body', 'headers', 'assertions', 'logs'] as const;
const MAX_PREVIEW_BODY_LENGTH = 512 * 1024;
const SAFE_IMAGE_TYPES: Record<string, true> = {
  'image/avif': true,
  'image/bmp': true,
  'image/gif': true,
  'image/jpeg': true,
  'image/png': true,
  'image/webp': true,
  'image/x-icon': true
};
const HTML_PREVIEW_POLICY = "default-src 'none'; img-src data: blob:; media-src data: blob:; style-src 'unsafe-inline'; font-src data:";

function formatJsonLosslessly(source: string): string | null {
  try {
    JSON.parse(source);
  } catch {
    return null;
  }

  let formatted = '';
  let depth = 0;
  let inString = false;
  let escaped = false;
  let previousToken = '';

  for (const character of source) {
    if (inString) {
      formatted += character;
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
        previousToken = '"';
      }
      continue;
    }

    if (/\s/.test(character)) continue;
    if (
      (previousToken === '{' && character !== '}')
      || (previousToken === '[' && character !== ']')
    ) {
      formatted += `\n${'  '.repeat(depth)}`;
    }
    if (character === '"') {
      inString = true;
      formatted += character;
      continue;
    }
    if (character === '{' || character === '[') {
      formatted += character;
      depth += 1;
      previousToken = character;
      continue;
    }
    if (character === '}' || character === ']') {
      depth -= 1;
      if (!((character === '}' && previousToken === '{') || (character === ']' && previousToken === '['))) {
        formatted += `\n${'  '.repeat(depth)}`;
      }
      formatted += character;
      previousToken = character;
      continue;
    }
    if (character === ',') {
      formatted += `,\n${'  '.repeat(depth)}`;
      previousToken = character;
      continue;
    }
    if (character === ':') {
      formatted += ': ';
      previousToken = character;
      continue;
    }
    formatted += character;
    previousToken = character;
  }

  return formatted;
}

function formatXml(source: string): string | null {
  const document = new DOMParser().parseFromString(source, 'application/xml');
  if (document.querySelector('parsererror')) return null;

  let depth = 0;
  return source
    .trim()
    .replace(/>\s*</g, '><')
    .replace(/></g, '>\n<')
    .split('\n')
    .map((line) => {
      const trimmed = line.trim();
      if (/^<\//.test(trimmed)) depth = Math.max(0, depth - 1);
      const formatted = `${'  '.repeat(depth)}${trimmed}`;
      if (
        /^<[^!?/][^>]*>$/.test(trimmed)
        && !/\/>$/.test(trimmed)
        && !/<\/[^>]+>$/.test(trimmed)
      ) {
        depth += 1;
      }
      return formatted;
    })
    .join('\n');
}

function responseContentType(response: ResponseData): string {
  const header = response.headers.find(
    (item) => item.encoding === 'utf8' && item.name.toLowerCase() === 'content-type'
  );
  return header?.value.split(';', 1)[0]?.trim().toLowerCase() ?? '';
}

function safeHtmlDocument(body: string): string {
  return `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_POLICY}"><meta name="referrer" content="no-referrer">${body}`;
}

function previewForResponse(response: ResponseData | null): BodyPreview | null {
  if (!response?.body) return null;
  const contentType = responseContentType(response);

  if (
    response.bodyEncoding === 'base64'
    && SAFE_IMAGE_TYPES[contentType]
  ) {
    return {
      view: 'image',
      label: 'Image',
      body: `data:${contentType};base64,${response.body}`,
      oversized: false
    };
  }
  if (response.bodyEncoding === 'base64') return null;
  if (response.body.length > MAX_PREVIEW_BODY_LENGTH) {
    return { view: 'json', label: 'Preview', body: response.body, oversized: true };
  }

  if (contentType === 'application/json' || contentType.endsWith('+json')) {
    const formatted = formatJsonLosslessly(response.body);
    return formatted === null
      ? null
      : { view: 'json', label: 'JSON', body: formatted, oversized: false };
  }
  if (contentType === 'text/html') {
    return {
      view: 'html',
      label: 'HTML',
      body: safeHtmlDocument(response.body),
      oversized: false
    };
  }
  if (
    contentType === 'application/xml'
    || contentType === 'text/xml'
    || contentType.endsWith('+xml')
  ) {
    const formatted = formatXml(response.body);
    return formatted === null
      ? null
      : { view: 'xml', label: 'XML', body: formatted, oversized: false };
  }

  const json = formatJsonLosslessly(response.body);
  if (json !== null) return { view: 'json', label: 'JSON', body: json, oversized: false };
  if (/^\s*(?:<!doctype\s+html|<html|<head|<body)\b/i.test(response.body)) {
    return {
      view: 'html',
      label: 'HTML',
      body: safeHtmlDocument(response.body),
      oversized: false
    };
  }
  if (/^\s*<\?xml\b/i.test(response.body)) {
    const xml = formatXml(response.body);
    if (xml !== null) return { view: 'xml', label: 'XML', body: xml, oversized: false };
  }
  return null;
}

export default function ResponsePanel(props: ResponsePanelProps) {
  const [tab, setTab] = createSignal<ResponseTab>('body');
  const [bodyViewOverride, setBodyViewOverride] = createSignal<{
    response: ResponseData;
    view: BodyView;
  } | null>(null);
  const bodyPreview = createMemo(() => previewForResponse(props.response));
  const bodyView = createMemo<BodyView>(() => {
    const response = props.response;
    const override = bodyViewOverride();
    if (response && override?.response === response) return override.view;
    const preview = bodyPreview();
    return preview && !preview.oversized ? preview.view : 'raw';
  });
  const bodyViewItems = createMemo(() => {
    const items: Array<{ value: BodyView; label: string; disabled?: boolean; title?: string }> = [
      { value: 'raw', label: 'Raw' }
    ];
    const preview = bodyPreview();
    if (preview) {
      items.push({
        value: preview.view,
        label: preview.label,
        disabled: preview.oversized,
        title: preview.oversized
          ? 'Preview is disabled for bodies larger than 512 KiB.'
          : undefined
      });
    }
    return items;
  });
  const setBodyView = (view: BodyView) => {
    const response = props.response;
    if (response) setBodyViewOverride({ response, view });
  };
  const displayedBody = createMemo(() => (
    bodyView() === 'json' || bodyView() === 'xml'
      ? bodyPreview()?.body ?? props.response?.body ?? ''
      : props.response?.body ?? ''
  ));
  const passedCount = createMemo(() => props.response?.assertions.filter((item) => item.passed).length ?? 0);

  return (
    <section
      class="response-panel @container grid w-full min-w-0 min-h-0 overflow-hidden bg-canvas [grid-template-rows:auto_auto_auto_minmax(0,1fr)] has-[.error-banner]:[grid-template-rows:auto_auto_auto_auto_minmax(0,1fr)]"
      aria-label="Response"
      aria-busy={props.pending ?? false}
    >
      <header class="response-heading flex min-h-19 items-center justify-between gap-4 border-b border-hairline bg-raised px-4 py-3">
        <div>
          <span class="eyebrow mb-1 flex items-center gap-1.5 font-data text-[0.6875rem] leading-none font-bold tracking-[0.07em] text-ink-muted">LATEST TRANSMISSION</span>
          <h2 class="m-0 text-lg leading-tight font-bold tracking-[-0.01em]">Response</h2>
        </div>
        <Show when={props.response?.truncated}>
          <span class="warning-chip rounded-sm border border-coral-line bg-coral-soft px-2 py-1 text-[0.6875rem] font-bold text-coral-ink">Captured prefix only</span>
        </Show>
      </header>

      <Show
        when={!props.pending}
        fallback={
          <div class="response-loading col-span-full row-[2/-1] m-6 grid min-h-64 place-content-center justify-items-center gap-3 rounded-md border border-dashed border-hairline p-8 text-center text-ink-muted" role="status" aria-live="polite">
            <span class="activity-line relative h-0.75 w-32 overflow-hidden bg-hairline after:block after:h-full after:w-[45%] after:animate-[scan_1s_var(--ease-out)_infinite] after:bg-signal after:content-[''] motion-reduce:after:animate-none" />
            <strong class="text-[0.9375rem] text-graphite">Request in flight</strong>
            <span>Waiting for the remote host…</span>
          </div>
        }
      >
        <Show
          when={props.response}
          fallback={
            <div class="response-empty col-span-full row-[2/-1] m-6 grid min-h-64 place-content-center justify-items-center gap-3 rounded-md border border-dashed border-hairline p-8 text-center text-ink-muted">
              <div class="radar relative size-18 rounded-full border border-signal-line shadow-[inset_0_0_0_1rem_var(--color-canvas),inset_0_0_0_1.0625rem_var(--color-signal-line)] before:absolute before:top-1/2 before:left-0 before:h-px before:w-full before:bg-signal-line before:content-[''] after:absolute after:top-0 after:left-1/2 after:h-full after:w-px after:bg-signal-line after:content-['']" aria-hidden="true" />
              <strong class="text-[0.9375rem] text-graphite">No transmission yet</strong>
              <span>Send the request to record status, timing, payload, and script output.</span>
            </div>
          }
        >
          {(response) => (
            <>
              <Show
                when={response().status !== null}
                fallback={
                  <div class="failure-summary grid grid-cols-[3.25rem_minmax(0,1fr)] items-start gap-3 border-b border-coral-line bg-coral-soft p-4" role="alert" aria-label="Response telemetry">
                    <strong class="failure-code pt-0.75 font-data text-lg leading-none font-extrabold text-coral-ink">ERR</strong>
                    <div>
                      <span class="eyebrow mb-1 flex items-center gap-1.5 font-data text-[0.6875rem] leading-none font-bold tracking-[0.07em] text-coral-ink">EXECUTION STOPPED</span>
                      <h3 class="m-0 mb-1 text-[0.9375rem] font-bold text-coral-ink">Request failed before a response arrived</h3>
                      <p class="m-0 font-data text-[0.8125rem] leading-[1.55] text-graphite [overflow-wrap:anywhere]">{response().error ?? 'The request ended before a remote host returned a response.'}</p>
                    </div>
                  </div>
                }
              >
                <div
                  class="telemetry-strip group/telemetry relative grid min-h-21 grid-cols-5 border-b border-border-strong bg-raised after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-signal-line after:content-[''] @max-response:grid-cols-2"
                  data-tone={statusTone(response().status)}
                  aria-label="Response telemetry"
                  role="status"
                  aria-live="polite"
                >
                  <div class="relative grid content-center gap-1 border-r border-hairline p-3 after:absolute after:top-1/2 after:right-2 after:size-1.25 after:-translate-y-1/2 after:rounded-full after:border after:border-signal after:bg-raised after:content-[''] group-data-[tone=good]/telemetry:shadow-[inset_0_0.1875rem_var(--color-signal)] group-data-[tone=bad]/telemetry:shadow-[inset_0_0.1875rem_var(--color-coral)]">
                    <span class="font-data text-[0.6875rem] leading-none font-bold tracking-[0.05em] text-ink-muted uppercase">Status</span>
                    <strong class="font-data text-xl leading-none [font-weight:750] text-graphite group-data-[tone=good]/telemetry:text-signal group-data-[tone=bad]/telemetry:text-coral">{response().status}</strong>
                  </div>
                  <div class="relative grid content-center gap-1 border-r border-hairline p-3 after:absolute after:top-1/2 after:right-2 after:size-1.25 after:-translate-y-1/2 after:rounded-full after:border after:border-signal after:bg-raised after:content-[''] @max-response:border-r-0 @max-response:after:hidden">
                    <span class="font-data text-[0.6875rem] leading-none font-bold tracking-[0.05em] text-ink-muted uppercase">Elapsed</span>
                    <strong class="font-data text-xl leading-none [font-weight:750] text-graphite">{response().elapsed} <small class="text-[0.6875rem] text-ink-muted">ms</small></strong>
                  </div>
                  <div class="relative grid content-center gap-1 border-r border-hairline p-3 after:absolute after:top-1/2 after:right-2 after:size-1.25 after:-translate-y-1/2 after:rounded-full after:border after:border-signal after:bg-raised after:content-[''] @max-response:border-t @max-response:border-hairline">
                    <span class="font-data text-[0.6875rem] leading-none font-bold tracking-[0.05em] text-ink-muted uppercase">Captured</span>
                    <strong class="font-data text-xl leading-none [font-weight:750] text-graphite">{formatBytes(response().size)}</strong>
                  </div>
                  <div class="relative grid content-center gap-1 border-r border-hairline p-3 after:absolute after:top-1/2 after:right-2 after:size-1.25 after:-translate-y-1/2 after:rounded-full after:border after:border-signal after:bg-raised after:content-[''] @max-response:border-t @max-response:border-r-0 @max-response:border-hairline @max-response:after:hidden">
                    <span class="font-data text-[0.6875rem] leading-none font-bold tracking-[0.05em] text-ink-muted uppercase">Total</span>
                    <strong class="font-data text-xl leading-none [font-weight:750] text-graphite">{response().totalSize === null ? 'Unknown' : formatBytes(response().totalSize!)}</strong>
                  </div>
                  <div class="relative grid content-center gap-1 p-3 @max-response:col-span-2 @max-response:border-t @max-response:border-hairline">
                    <span class="font-data text-[0.6875rem] leading-none font-bold tracking-[0.05em] text-ink-muted uppercase">Checks</span>
                    <strong class="font-data text-xl leading-none [font-weight:750] text-graphite">{passedCount()}<small class="text-[0.6875rem] text-ink-muted">/{response().assertions.length}</small></strong>
                  </div>
                </div>
                <Show when={response().error}>
                  {(error) => (
                    <div class="error-banner grid gap-1 border-b border-coral-line bg-coral-soft px-4 py-3 text-coral-ink" role="alert">
                      <strong>Request completed with an error</strong>
                      <span class="text-[0.8125rem] leading-6 text-graphite">{error()}</span>
                    </div>
                  )}
                </Show>
              </Show>

              <Tabs
                items={RESPONSE_TABS}
                value={tab()}
                onChange={setTab}
                idPrefix="response"
                panelId="response-tabpanel"
                ariaLabel="Response details"
                class="response-tabs flex min-h-11 shrink-0 items-end gap-6 border-b border-border-strong bg-raised px-4 @max-response:gap-4"
                buttonClass="cursor-pointer whitespace-nowrap focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-raised"
                activeClass="hover:text-graphite"
                inactiveClass="hover:text-naval"
                renderLabel={(item) => (
                  <>
                    {item}
                    {item === 'headers'
                      ? ` ${response().headers.length}`
                      : item === 'assertions'
                        ? ` ${response().assertions.length}`
                        : item === 'logs'
                          ? ` ${response().logs.length}`
                          : ''}
                  </>
                )}
              />

              <div
                class="response-content min-h-0 bg-reader p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-signal"
                classList={{
                  'flex': tab() === 'body',
                  'flex-col': tab() === 'body',
                  'overflow-hidden': tab() === 'body',
                  'overflow-auto': tab() !== 'body'
                }}
                id="response-tabpanel"
                role="tabpanel"
                tabindex="0"
                aria-labelledby={`response-tab-${tab()}`}
              >
                <Show when={tab() === 'body'}>
                  <Show
                    when={response().body}
                    fallback={<p class="inline-empty m-0 grid min-h-full place-content-center text-center text-[0.8125rem] text-ink-muted">The response body is empty.</p>}
                  >
                    <Show when={response().bodyEncoding === 'base64'}>
                      <p class="response-body-notice m-0 mb-3 shrink-0 text-xs leading-6 text-ink-muted">Binary response bytes are shown as base64. Decode this value to recover the exact captured payload.</p>
                    </Show>
                    <SegmentedControl
                      items={bodyViewItems()}
                      value={bodyView()}
                      onChange={setBodyView}
                      ariaLabel="Response body view"
                      class="mb-3 max-w-full shrink-0"
                      buttonClass="cursor-pointer focus-visible:z-10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal disabled:opacity-50"
                      activeClass="hover:text-raised"
                      inactiveClass="hover:text-naval"
                    />
                    <Show when={bodyPreview()?.oversized}>
                      <p class="response-body-notice m-0 mb-3 shrink-0 text-xs leading-6 text-ink-muted">
                        Raw captured content is shown. Preview is disabled above 512 KiB of captured text to avoid duplicating large payloads in memory.
                      </p>
                    </Show>
                    <Show
                      when={bodyView() === 'html'}
                      fallback={
                        <Show
                          when={bodyView() === 'image'}
                          fallback={<pre class="response-body m-0 min-h-0 flex-1 overflow-auto rounded-sm border border-hairline bg-raised p-4 font-data text-[0.8125rem] leading-[1.7] whitespace-pre-wrap text-naval [overflow-wrap:anywhere]">{displayedBody()}</pre>}
                        >
                          <figure class="response-image m-0 grid min-h-0 flex-1 place-items-center overflow-auto rounded-sm border border-hairline bg-raised p-4">
                            <img class="block max-h-full max-w-full object-contain" src={bodyPreview()?.body} alt="Response body preview" />
                          </figure>
                        </Show>
                      }
                    >
                      <iframe
                        class="response-html min-h-0 w-full flex-1 rounded-sm border border-hairline bg-white"
                        title="Response HTML preview"
                        sandbox=""
                        referrerpolicy="no-referrer"
                        srcdoc={bodyPreview()?.body}
                      />
                    </Show>
                  </Show>
                </Show>
                <Show when={tab() === 'headers'}>
                  <Show
                    when={response().headers.length > 0}
                    fallback={<p class="inline-empty m-0 grid min-h-full place-content-center text-center text-[0.8125rem] text-ink-muted">No response headers were recorded.</p>}
                  >
                    <dl class="header-list m-0">
                      <For each={response().headers}>
                        {(header) => (
                          <div class="grid grid-cols-[minmax(7rem,0.4fr)_minmax(0,1fr)] gap-4 border-b border-hairline py-2">
                            <dt class="font-data text-signal-ink">{header.name}</dt>
                            <dd class="m-0 font-data text-naval [overflow-wrap:anywhere]">{header.value}{header.encoding === 'base64' ? ' (base64)' : ''}</dd>
                          </div>
                        )}
                      </For>
                    </dl>
                  </Show>
                </Show>
                <Show when={tab() === 'assertions'}>
                  <Show
                    when={response().assertions.length > 0}
                    fallback={<p class="inline-empty m-0 grid min-h-full place-content-center text-center text-[0.8125rem] text-ink-muted">No assertions ran. Add checks in the after-response script.</p>}
                  >
                    <ul class="assertion-list m-0 list-none p-0">
                      <For each={response().assertions}>
                        {(assertion) => (
                          <li class="flex gap-3 border-b border-hairline py-3" classList={{ passed: assertion.passed }}>
                            <span
                              class="min-w-11 font-data text-[0.6875rem] leading-[1.5] [font-weight:750]"
                              classList={{ 'text-signal-ink': assertion.passed, 'text-coral-ink': !assertion.passed }}
                            >
                              {assertion.passed ? 'PASS' : 'FAIL'}
                            </span>
                            <div>
                              <strong class="text-[0.8125rem]">{assertion.name}</strong>
                              <Show when={assertion.message}><p class="mt-1 mb-0 text-xs text-ink-muted">{assertion.message}</p></Show>
                            </div>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </Show>
                <Show when={tab() === 'logs'}>
                  <Show
                    when={response().logs.length > 0}
                    fallback={<p class="inline-empty m-0 grid min-h-full place-content-center text-center text-[0.8125rem] text-ink-muted">No script logs were recorded.</p>}
                  >
                    <ol class="log-list m-0 list-none p-0">
                      <For each={response().logs}>
                        {(log, index) => (
                          <li class="grid grid-cols-[2rem_minmax(0,1fr)] gap-2 border-b border-hairline py-2">
                            <span class="font-data text-[0.6875rem] leading-[1.5] text-ink-muted">{String(index() + 1).padStart(2, '0')}</span>
                            <code class="font-data text-[0.8125rem] text-naval [overflow-wrap:anywhere]">{log}</code>
                          </li>
                        )}
                      </For>
                    </ol>
                  </Show>
                </Show>
              </div>
            </>
          )}
        </Show>
      </Show>
    </section>
  );
}
