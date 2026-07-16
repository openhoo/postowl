import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import type { Collection, RequestDraft } from '../types';
import type { RequestValidationErrors } from '../validation';
import { BODY_MODES, METHODS } from '../utils';
import ActionButton from './ActionButton';
import KeyValueEditor from './KeyValueEditor';

export interface RequestEditorValidationController {
  focusFirstInvalid: () => boolean;
}

export interface RequestEditorProps {
  draft: RequestDraft;
  collections: Collection[];
  dirty: boolean;
  busy: boolean;
  saving: boolean;
  sending: boolean;
  validationErrors?: RequestValidationErrors;
  onValidationController?: (controller: RequestEditorValidationController | undefined) => void;
  onDraftChange: (next: RequestDraft) => void;
  onSave: () => void;
  onSend: () => void;
  onDelete: () => void;
}

type RequestTab = 'query' | 'headers' | 'body' | 'scripts';
type ScriptTab = 'pre' | 'post';
const REQUEST_TABS = ['query', 'headers', 'body', 'scripts'] as const;

export default function RequestEditor(props: RequestEditorProps) {
  const [tab, setTab] = createSignal<RequestTab>('query');
  const [scriptTab, setScriptTab] = createSignal<ScriptTab>('pre');
  let editorElement!: HTMLElement;

  const focusFirstInvalid = () => {
    const errors = props.validationErrors;
    if (!errors) return false;

    let selector: string | undefined;
    if (errors.name) selector = '#request-name';
    else if (errors.url) selector = '#request-url';
    else if (Object.values(errors.query ?? {}).some((row) => row?.name || row?.value)) {
      setTab('query');
      selector = '#request-tabpanel [aria-invalid="true"]';
    } else if (Object.values(errors.headers ?? {}).some((row) => row?.name || row?.value)) {
      setTab('headers');
      selector = '#request-tabpanel [aria-invalid="true"]';
    } else if (errors.body) {
      setTab('body');
      selector = '#request-body';
    } else if (errors.preRequestScript || errors.postResponseScript) {
      setTab('scripts');
      setScriptTab(errors.preRequestScript ? 'pre' : 'post');
      selector = errors.preRequestScript ? '#request-pre-script' : '#request-post-script';
    }
    if (!selector) return false;

    queueMicrotask(() => editorElement.querySelector<HTMLElement>(selector)?.focus());
    return true;
  };

  onMount(() => props.onValidationController?.({ focusFirstInvalid }));
  onCleanup(() => props.onValidationController?.(undefined));

  const updateDraft = <K extends keyof RequestDraft>(key: K, value: RequestDraft[K]) => {
    props.onDraftChange({ ...props.draft, [key]: value });
  };
  const moveTabFocus = (event: KeyboardEvent & { currentTarget: HTMLButtonElement }, current: RequestTab) => {
    const currentIndex = REQUEST_TABS.indexOf(current);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? REQUEST_TABS.length - 1
        : event.key === 'ArrowLeft'
          ? (currentIndex - 1 + REQUEST_TABS.length) % REQUEST_TABS.length
          : event.key === 'ArrowRight'
            ? (currentIndex + 1) % REQUEST_TABS.length
            : currentIndex;
    if (nextIndex === currentIndex && !['Home', 'End'].includes(event.key)) return;
    const tabButtons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    event.preventDefault();
    setTab(REQUEST_TABS[nextIndex]);
    queueMicrotask(() => tabButtons?.[nextIndex]?.focus());
  };


  return (
    <section ref={editorElement} class="request-editor" aria-label="Request editor" aria-busy={props.busy}>
      <header class="editor-titlebar">
        <div class="request-identity">
          <span class="eyebrow request-state" classList={{ dirty: props.dirty }}>
            <span class="state-dot" aria-hidden="true" />
            {props.dirty ? 'Unsaved changes' : 'Saved request'}
          </span>
          <div class="field-control title-control">
            <input
              id="request-name"
              class="title-input"
              value={props.draft.name}
              onInput={(event) => updateDraft('name', event.currentTarget.value)}
              aria-label="Request name"
              aria-invalid={props.validationErrors?.name ? 'true' : undefined}
              aria-describedby={props.validationErrors?.name ? 'request-name-error' : undefined}
              disabled={props.busy}
            />
            <Show when={props.validationErrors?.name}>
              {(message) => <span id="request-name-error" class="field-error" role="alert">{message()}</span>}
            </Show>
          </div>
          <Show when={props.validationErrors?.summary}>
            {(message) => <span class="field-error" role="alert">{message()}</span>}
          </Show>
        </div>
        <label class="compact-field">
          <span>Collection</span>
          <select
            value={props.draft.collectionId ?? ''}
            onChange={(event) => updateDraft('collectionId', event.currentTarget.value || null)}
            aria-label="Collection"
            disabled={props.busy}
          >
            <option value="">Unfiled</option>
            <For each={props.collections}>
              {(collection) => <option value={collection.id}>{collection.name}</option>}
            </For>
          </select>
        </label>
        <div class="toolbar-actions">
          <ActionButton onClick={props.onDelete} tone="danger" disabled={props.busy}>Delete</ActionButton>
          <button
            type="button"
            class="action"
            onClick={props.onSave}
            disabled={props.busy || !props.dirty}
            aria-keyshortcuts="Control+S Meta+S"
          >
            {props.saving ? 'Saving…' : props.dirty ? 'Save' : 'Saved'} <kbd>Ctrl/Command+S</kbd>
          </button>
        </div>
      </header>

      <div class="request-line">
        <select
          class={`method method-${props.draft.method.toLowerCase()}`}
          value={props.draft.method}
          onChange={(event) => updateDraft('method', event.currentTarget.value)}
          aria-label="HTTP method"
          disabled={props.busy}
        >
          <For each={METHODS}>{(method) => <option value={method}>{method}</option>}</For>
        </select>
        <div class="field-control url-control">
          <input
            id="request-url"
            class="url-input mono"
            value={props.draft.url}
            onInput={(event) => updateDraft('url', event.currentTarget.value)}
            aria-label="Request URL"
            aria-invalid={props.validationErrors?.url ? 'true' : undefined}
            aria-describedby={props.validationErrors?.url ? 'request-url-error' : undefined}
            placeholder="https://api.example.com/resource"
            spellcheck={false}
            disabled={props.busy}
          />
          <Show when={props.validationErrors?.url}>
            {(message) => <span id="request-url-error" class="field-error" role="alert">{message()}</span>}
          </Show>
        </div>
        <button
          type="button"
          class="action primary"
          onClick={props.onSend}
          disabled={props.busy || !props.draft.url.trim()}
          aria-keyshortcuts="Control+Enter Meta+Enter"
        >
          {props.sending ? 'Sending…' : 'Send'} <kbd>Ctrl/Command+Enter</kbd>
        </button>
      </div>

      <nav class="tabs" aria-label="Request settings" role="tablist">
        <For each={REQUEST_TABS}>
          {(item) => (
            <button
              type="button"
              role="tab"
              aria-selected={tab() === item}
              id={`request-tab-${item}`}
              aria-controls="request-tabpanel"
              tabindex={tab() === item ? 0 : -1}
              classList={{ active: tab() === item }}
              onClick={() => setTab(item)}
              onKeyDown={(event) => moveTabFocus(event, item)}
            >
              {item}
            </button>
          )}
        </For>
      </nav>

      <div class="editor-pane" id="request-tabpanel" role="tabpanel" aria-labelledby={`request-tab-${tab()}`}>
        <Show when={tab() === 'query'}>
          <KeyValueEditor
            rows={props.draft.query}
            kind="Query parameter"
            idPrefix="request-query"
            errors={props.validationErrors?.query}
            disabled={props.busy}
            onRowsChange={(query) => props.onDraftChange({ ...props.draft, query })}
            keyLabel="Name"
            valueLabel="Value"
            addLabel="Add parameter"
          />
        </Show>
        <Show when={tab() === 'headers'}>
          <KeyValueEditor
            rows={props.draft.headers}
            kind="Header"
            idPrefix="request-header"
            errors={props.validationErrors?.headers}
            disabled={props.busy}
            onRowsChange={(headers) => props.onDraftChange({ ...props.draft, headers })}
            keyLabel="Name"
            valueLabel="Value"
            addLabel="Add header"
          />
        </Show>
        <Show when={tab() === 'body'}>
          <div class="segmented" aria-label="Body mode" role="group">
            <For each={BODY_MODES}>
              {(mode) => (
                <button
                  type="button"
                  aria-pressed={props.draft.bodyMode === mode}
                  classList={{ active: props.draft.bodyMode === mode }}
                  disabled={props.busy}
                  onClick={() => updateDraft('bodyMode', mode)}
                >
                  {mode}
                </button>
              )}
            </For>
          </div>
          <Show
            when={props.draft.bodyMode !== 'none'}
            fallback={<div class="pane-empty"><strong>No request body</strong><span>Choose text, JSON, or form to attach a payload.</span></div>}
          >
            <div class="field-control body-control">
              <textarea
                id="request-body"
                class="code-editor"
                value={props.draft.body}
                onInput={(event) => updateDraft('body', event.currentTarget.value)}
                aria-label="Request body"
                aria-invalid={props.validationErrors?.body ? 'true' : undefined}
                aria-describedby={props.validationErrors?.body ? 'request-body-error' : undefined}
                spellcheck={false}
                disabled={props.busy}
                placeholder={props.draft.bodyMode === 'json' ? '{\n  "key": "value"\n}' : 'Request payload'}
              />
              <Show when={props.validationErrors?.body}>
                {(message) => <span id="request-body-error" class="field-error" role="alert">{message()}</span>}
              </Show>
              <Show when={props.draft.bodyMode === 'form'}>
                <p class="editor-help">Sent as raw URL-encoded text. Enter pairs such as <code>name=owl&amp;active=true</code>.</p>
              </Show>
            </div>
          </Show>
        </Show>
        <Show when={tab() === 'scripts'}>
          <div class="segmented" aria-label="Script stage" role="group">
            <button type="button" aria-pressed={scriptTab() === 'pre'} classList={{ active: scriptTab() === 'pre' }} onClick={() => setScriptTab('pre')}>Before request</button>
            <button type="button" aria-pressed={scriptTab() === 'post'} classList={{ active: scriptTab() === 'post' }} onClick={() => setScriptTab('post')}>After response</button>
          </div>
          <Show
            when={scriptTab() === 'pre'}
            fallback={(
              <div class="field-control">
                <textarea
                  id="request-post-script"
                  class="code-editor"
                  value={props.draft.postResponseScript}
                  onInput={(event) => updateDraft('postResponseScript', event.currentTarget.value)}
                  aria-label="Post-response script"
                  aria-invalid={props.validationErrors?.postResponseScript ? 'true' : undefined}
                  aria-describedby={props.validationErrors?.postResponseScript ? 'request-post-script-error' : undefined}
                  spellcheck={false}
                  disabled={props.busy}
                  placeholder="// Return { variables, assertions, logs }"
                />
                <Show when={props.validationErrors?.postResponseScript}>
                  {(message) => <span id="request-post-script-error" class="field-error" role="alert">{message()}</span>}
                </Show>
              </div>
            )}
          >
            <div class="field-control">
              <textarea
                id="request-pre-script"
                class="code-editor"
                value={props.draft.preRequestScript}
                onInput={(event) => updateDraft('preRequestScript', event.currentTarget.value)}
                aria-label="Pre-request script"
                aria-invalid={props.validationErrors?.preRequestScript ? 'true' : undefined}
                aria-describedby={props.validationErrors?.preRequestScript ? 'request-pre-script-error' : undefined}
                spellcheck={false}
                disabled={props.busy}
                placeholder="// Return { request, variables, assertions, logs }"
              />
              <Show when={props.validationErrors?.preRequestScript}>
                {(message) => <span id="request-pre-script-error" class="field-error" role="alert">{message()}</span>}
              </Show>
            </div>
          </Show>
          <p class="editor-help">Scripts export <code>main(context)</code> and return an object. Before request, return any of <code>request</code>, <code>variables</code>, <code>assertions</code>, or <code>logs</code>; after response, return <code>variables</code>, <code>assertions</code>, or <code>logs</code>.</p>
        </Show>
      </div>
    </section>
  );
}
