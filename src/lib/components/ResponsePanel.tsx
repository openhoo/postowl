import { For, Show, createMemo, createSignal } from 'solid-js';
import type { ResponseData } from '../types';
import { formatBytes, statusTone } from '../utils';

interface ResponsePanelProps {
  response: ResponseData | null;
  pending?: boolean;
}

type ResponseTab = 'body' | 'headers' | 'assertions' | 'logs';
type BodyView = 'raw' | 'pretty';

const RESPONSE_TABS = ['body', 'headers', 'assertions', 'logs'] as const;
const MAX_PRETTY_BODY_LENGTH = 512 * 1024;

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

export default function ResponsePanel(props: ResponsePanelProps) {
  const [tab, setTab] = createSignal<ResponseTab>('body');
  const [bodyView, setBodyView] = createSignal<BodyView>('raw');
  const prettyBody = createMemo(() => {
    if (props.response?.bodyEncoding === 'base64') {
      return { available: false, body: props.response.body, oversized: false };
    }
    const body = props.response?.body ?? '';
    if (!body) return { available: false, body, oversized: false };
    if (body.length > MAX_PRETTY_BODY_LENGTH) {
      return { available: false, body, oversized: true };
    }
    const formatted = formatJsonLosslessly(body);
    return { available: formatted !== null, body: formatted ?? body, oversized: false };
  });
  const displayedBody = createMemo(() => (
    bodyView() === 'pretty' && prettyBody().available
      ? prettyBody().body
      : props.response?.body ?? ''
  ));
  const passedCount = createMemo(() => props.response?.assertions.filter((item) => item.passed).length ?? 0);
  const moveTabFocus = (event: KeyboardEvent & { currentTarget: HTMLButtonElement }, current: ResponseTab) => {
    const currentIndex = RESPONSE_TABS.indexOf(current);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? RESPONSE_TABS.length - 1
        : event.key === 'ArrowLeft'
          ? (currentIndex - 1 + RESPONSE_TABS.length) % RESPONSE_TABS.length
          : event.key === 'ArrowRight'
            ? (currentIndex + 1) % RESPONSE_TABS.length
            : currentIndex;
    if (nextIndex === currentIndex && !['Home', 'End'].includes(event.key)) return;
    const tabButtons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    event.preventDefault();
    setTab(RESPONSE_TABS[nextIndex]);
    queueMicrotask(() => tabButtons?.[nextIndex]?.focus());
  };

  return (
    <section class="response-panel" aria-label="Response" aria-busy={props.pending ?? false}>
      <header class="response-heading">
        <div><span class="eyebrow">LATEST TRANSMISSION</span><h2>Response</h2></div>
        <Show when={props.response?.truncated}><span class="warning-chip">Captured prefix only</span></Show>
      </header>

      <Show
        when={!props.pending}
        fallback={<div class="response-loading" role="status" aria-live="polite"><span class="activity-line" /><strong>Request in flight</strong><span>Waiting for the remote host…</span></div>}
      >
        <Show
          when={props.response}
          fallback={<div class="response-empty"><div class="radar" aria-hidden="true" /><strong>No transmission yet</strong><span>Send the request to record status, timing, payload, and script output.</span></div>}
        >
          {(response) => (
            <>
              <Show
                when={response().status !== null}
                fallback={
                  <div class="failure-summary" role="alert" aria-label="Response telemetry">
                    <strong class="failure-code">ERR</strong>
                    <div>
                      <span class="eyebrow">EXECUTION STOPPED</span>
                      <h3>Request failed before a response arrived</h3>
                      <p>{response().error ?? 'The request ended before a remote host returned a response.'}</p>
                    </div>
                  </div>
                }
              >
                <div class="telemetry-strip" data-tone={statusTone(response().status)} aria-label="Response telemetry" role="status" aria-live="polite">
                  <div><span>Status</span><strong>{response().status}</strong></div>
                  <div><span>Elapsed</span><strong>{response().elapsed} <small>ms</small></strong></div>
                  <div><span>Captured</span><strong>{formatBytes(response().size)}</strong></div>
                  <div><span>Total</span><strong>{response().totalSize === null ? 'Unknown' : formatBytes(response().totalSize!)}</strong></div>
                  <div><span>Checks</span><strong>{passedCount()}<small>/{response().assertions.length}</small></strong></div>
                </div>
                <Show when={response().error}>
                  {(error) => <div class="error-banner" role="alert"><strong>Request completed with an error</strong><span>{error()}</span></div>}
                </Show>
              </Show>

              <nav class="tabs response-tabs" aria-label="Response details" role="tablist">
                <For each={RESPONSE_TABS}>
                  {(item) => (
                    <button
                      type="button"
                      role="tab"
                      aria-selected={tab() === item}
                      id={`response-tab-${item}`}
                      aria-controls="response-tabpanel"
                      tabindex={tab() === item ? 0 : -1}
                      classList={{ active: tab() === item }}
                      onClick={() => setTab(item)}
                      onKeyDown={(event) => moveTabFocus(event, item)}
                    >
                      {item}
                      {item === 'headers'
                        ? ` ${response().headers.length}`
                        : item === 'assertions'
                          ? ` ${response().assertions.length}`
                          : item === 'logs'
                            ? ` ${response().logs.length}`
                            : ''}
                    </button>
                  )}
                </For>
              </nav>

              <div class="response-content" id="response-tabpanel" role="tabpanel" tabindex="0" aria-labelledby={`response-tab-${tab()}`}>
                <Show when={tab() === 'body'}>
                  <Show when={response().body} fallback={<p class="inline-empty">The response body is empty.</p>}>
                    <Show when={response().bodyEncoding === 'base64'}>
                      <p class="editor-help">Binary response bytes are shown as base64. Decode this value to recover the exact captured payload.</p>
                    </Show>
                    <div class="segmented" aria-label="Response body view" role="group">
                      <button
                        type="button"
                        aria-pressed={bodyView() === 'raw' || !prettyBody().available}
                        classList={{ active: bodyView() === 'raw' || !prettyBody().available }}
                        onClick={() => setBodyView('raw')}
                      >
                        Raw
                      </button>
                      <button
                        type="button"
                        aria-pressed={bodyView() === 'pretty' && prettyBody().available}
                        classList={{ active: bodyView() === 'pretty' && prettyBody().available }}
                        disabled={response().bodyEncoding === 'base64' || !prettyBody().available}
                        title={response().bodyEncoding === 'base64'
                          ? 'Pretty view is unavailable for binary response bodies.'
                          : prettyBody().oversized
                            ? 'Pretty view is disabled for large captured bodies.'
                            : prettyBody().available
                              ? undefined
                              : 'Pretty view requires valid JSON.'}
                        onClick={() => setBodyView('pretty')}
                      >
                        Pretty
                      </button>
                    </div>
                    <Show when={prettyBody().oversized}>
                      <p class="editor-help">
                        Raw captured content is shown. Pretty view is disabled above 512 KiB of captured text to avoid duplicating large payloads in memory.
                      </p>
                    </Show>
                    <pre class="response-body">{displayedBody()}</pre>
                  </Show>
                </Show>
                <Show when={tab() === 'headers'}>
                  <Show when={response().headers.length > 0} fallback={<p class="inline-empty">No response headers were recorded.</p>}>
                    <dl class="header-list">
                      <For each={response().headers}>
                        {(header) => <div><dt>{header.name}</dt><dd>{header.value}{header.encoding === 'base64' ? ' (base64)' : ''}</dd></div>}
                      </For>
                    </dl>
                  </Show>
                </Show>
                <Show when={tab() === 'assertions'}>
                  <Show when={response().assertions.length > 0} fallback={<p class="inline-empty">No assertions ran. Add checks in the after-response script.</p>}>
                    <ul class="assertion-list">
                      <For each={response().assertions}>
                        {(assertion) => (
                          <li classList={{ passed: assertion.passed }}>
                            <span>{assertion.passed ? 'PASS' : 'FAIL'}</span>
                            <div>
                              <strong>{assertion.name}</strong>
                              <Show when={assertion.message}><p>{assertion.message}</p></Show>
                            </div>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </Show>
                <Show when={tab() === 'logs'}>
                  <Show when={response().logs.length > 0} fallback={<p class="inline-empty">No script logs were recorded.</p>}>
                    <ol class="log-list">
                      <For each={response().logs}>
                        {(log, index) => <li><span>{String(index() + 1).padStart(2, '0')}</span><code>{log}</code></li>}
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
