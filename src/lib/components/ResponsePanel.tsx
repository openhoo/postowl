import { For, Show, createMemo, createSignal } from 'solid-js';
import type { ResponseData } from '../types';
import { formatBytes, statusTone } from '../utils';

interface ResponsePanelProps {
  response: ResponseData | null;
  pending?: boolean;
}

type ResponseTab = 'body' | 'headers' | 'assertions' | 'logs';

export default function ResponsePanel(props: ResponsePanelProps) {
  const [tab, setTab] = createSignal<ResponseTab>('body');
  const prettyBody = createMemo(() => {
    if (!props.response?.body) return '';
    try {
      return JSON.stringify(JSON.parse(props.response.body), null, 2);
    } catch {
      return props.response.body;
    }
  });
  const passedCount = createMemo(() => props.response?.assertions.filter((item) => item.passed).length ?? 0);

  return (
    <section class="response-panel" aria-label="Response">
      <header class="response-heading">
        <div><span class="eyebrow">RESPONSE RECORDER</span><h2>Telemetry</h2></div>
        <Show when={props.response?.truncated}><span class="warning-chip">Body truncated</span></Show>
      </header>

      <Show
        when={!props.pending}
        fallback={<div class="response-loading" aria-live="polite"><span class="activity-line" /><strong>Request in flight</strong><span>Waiting for the remote host…</span></div>}
      >
        <Show
          when={props.response}
          fallback={<div class="response-empty"><div class="radar" aria-hidden="true" /><strong>No transmission yet</strong><span>Send the request to record status, timing, payload, and script output.</span></div>}
        >
          {(response) => (
            <>
              <div class="telemetry-strip" data-tone={statusTone(response().status)} aria-label="Response telemetry">
                <div><span>Status</span><strong>{response().status ?? 'ERR'}</strong></div>
                <div><span>Elapsed</span><strong>{response().elapsed} <small>ms</small></strong></div>
                <div><span>Transfer</span><strong>{formatBytes(response().size)}</strong></div>
                <div><span>Checks</span><strong>{passedCount()}<small>/{response().assertions.length}</small></strong></div>
              </div>

              <Show when={response().error}>
                {(error) => <div class="error-banner" role="alert"><strong>Request failed</strong><span>{error()}</span></div>}
              </Show>

              <nav class="tabs response-tabs" aria-label="Response details">
                <For each={['body', 'headers', 'assertions', 'logs'] as const}>
                  {(item) => (
                    <button type="button" classList={{ active: tab() === item }} onClick={() => setTab(item)}>
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

              <div class="response-content">
                <Show when={tab() === 'body'}>
                  <Show when={prettyBody()} fallback={<p class="inline-empty">The response body is empty.</p>}>
                    {(body) => <pre class="response-body">{body()}</pre>}
                  </Show>
                </Show>
                <Show when={tab() === 'headers'}>
                  <Show when={response().headers.length > 0} fallback={<p class="inline-empty">No response headers were recorded.</p>}>
                    <dl class="header-list">
                      <For each={response().headers}>
                        {(header) => <div><dt>{header.name}</dt><dd>{header.value}</dd></div>}
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
