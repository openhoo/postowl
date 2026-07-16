import { For, Show, createSignal, onCleanup, onMount } from 'solid-js';
import type { Collection, RequestDraft } from '../types';
import type { RequestValidationErrors } from '../validation';
import { BODY_MODES, METHODS } from '../utils';
import KeyValueEditor from './KeyValueEditor';
import FieldError from './ui/FieldError';
import SegmentedControl from './ui/SegmentedControl';
import Tabs from './ui/Tabs';

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
const SCRIPT_STAGES = [
  { value: 'pre', label: 'Before request' },
  { value: 'post', label: 'After response' }
] as const;
const CONTROL_CLASS = 'min-h-control-default rounded-sm border border-hairline bg-raised px-2 py-1 hover:border-signal-line focus-visible:relative focus-visible:z-2 focus-visible:outline-0 focus-visible:[box-shadow:var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-48';
const ACTION_CLASS = 'min-h-control-default whitespace-nowrap rounded-sm border px-3 py-1 text-[0.8125rem] font-[650] transition-[border-color,background-color,color,box-shadow,transform] duration-[140ms] ease-out active:not-disabled:translate-y-px focus-visible:relative focus-visible:z-2 focus-visible:outline-0 focus-visible:[box-shadow:var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-48';
const QUIET_ACTION_CLASS = 'border-hairline bg-raised text-naval hover:not-disabled:border-signal-line hover:not-disabled:bg-signal-soft hover:not-disabled:text-graphite';
const DANGER_ACTION_CLASS = 'border-transparent bg-transparent text-coral-ink hover:not-disabled:border-coral-line hover:not-disabled:bg-coral-soft hover:not-disabled:text-coral-ink';
const PRIMARY_ACTION_CLASS = 'border-naval bg-naval font-[750] text-raised shadow-[inset_0_0.125rem_var(--color-signal-bright)] hover:not-disabled:border-graphite hover:not-disabled:bg-graphite hover:not-disabled:text-raised';
const CODE_EDITOR_CLASS = 'h-[calc(100%_-_3rem)] min-h-56 w-full resize-none rounded-sm border border-border-strong bg-reader p-4 font-data text-[0.8125rem] leading-[1.65] text-graphite [tab-size:2] placeholder:text-ink-faint hover:border-signal-line focus-visible:relative focus-visible:z-2 focus-visible:outline-0 focus-visible:[box-shadow:var(--focus-ring)] aria-invalid:border-coral-line disabled:cursor-not-allowed disabled:opacity-48';

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


  return (
    <section ref={editorElement} class="request-editor grid min-h-0 min-w-0 grid-rows-[auto_auto_auto_minmax(0,1fr)] overflow-hidden bg-panel @max-[50rem]:border-b @max-[50rem]:border-border-strong" aria-label="Request editor" aria-busy={props.busy}>
      <header class="editor-titlebar flex min-h-19 min-w-0 items-center gap-4 border-b border-hairline bg-raised px-4 py-3 max-[68rem]:flex-wrap max-[36rem]:min-h-0 max-[36rem]:flex-col max-[36rem]:items-stretch max-[36rem]:gap-2 max-[36rem]:p-2">
        <div class="request-identity min-w-36 flex-1 max-[68rem]:basis-52 max-[36rem]:w-full max-[36rem]:min-w-0 max-[36rem]:basis-auto">
          <span class="eyebrow request-state mb-1 flex items-center gap-1.5 font-data text-[0.6875rem] leading-none font-bold tracking-[0.04em] text-ink-muted" classList={{ dirty: props.dirty, 'text-coral-ink': props.dirty }}>
            <span class="state-dot size-1.75 rounded-full" classList={{ 'bg-signal': !props.dirty, 'bg-coral shadow-[0_0_0_0.1875rem_var(--color-coral-soft)]': props.dirty }} aria-hidden="true" />
            {props.dirty ? 'Unsaved changes' : 'Saved request'}
          </span>
          <div class="field-control title-control grid min-w-0 content-start">
            <input
              id="request-name"
              class={`title-input w-full ${CONTROL_CLASS} aria-invalid:border-coral-line`}
              value={props.draft.name}
              onInput={(event) => updateDraft('name', event.currentTarget.value)}
              aria-label="Request name"
              aria-invalid={props.validationErrors?.name ? 'true' : undefined}
              aria-describedby={props.validationErrors?.name ? 'request-name-error' : undefined}
              disabled={props.busy}
            />
            <FieldError id="request-name-error" message={props.validationErrors?.name} />
          </div>
          <FieldError message={props.validationErrors?.summary} />
        </div>
        <label class="flex shrink-0 items-center gap-2 whitespace-nowrap text-[0.6875rem] font-semibold text-ink-muted">
          <span>Collection</span>
          <select class={`w-38 min-w-0 ${CONTROL_CLASS}`}
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
        <div class="toolbar-actions flex items-center gap-2 max-[36rem]:w-full max-[36rem]:flex-wrap max-[36rem]:gap-1 [&_.action]:max-[36rem]:min-w-0 [&_.action]:max-[36rem]:flex-[1_1_auto]">
          <button
            type="button"
            class={`action danger ${ACTION_CLASS} ${DANGER_ACTION_CLASS}`}
            onClick={props.onDelete}
            disabled={props.busy}
          >
            Delete
          </button>
          <button
            type="button"
            class={`action ${ACTION_CLASS} ${QUIET_ACTION_CLASS}`}
            onClick={props.onSave}
            disabled={props.busy || !props.dirty}
            aria-keyshortcuts="Control+S Meta+S"
          >
            {props.saving ? 'Saving…' : props.dirty ? 'Save' : 'Saved'} <kbd class="ml-1 font-data text-[0.6875rem] leading-none font-[650] opacity-72">Ctrl/Command+S</kbd>
          </button>
        </div>
      </header>

      <div class="request-line grid grid-cols-[5.75rem_minmax(0,1fr)_auto] items-start gap-2 border-b border-hairline bg-canvas px-4 py-3 @max-response:grid-cols-[4.75rem_minmax(0,1fr)] @max-response:p-2 @max-response:[&_.action]:col-span-full">
        <select
          class={`method method-${props.draft.method.toLowerCase()} ${CONTROL_CLASS} font-data text-[0.8125rem] leading-none font-[750]`}
          classList={{
            'text-signal-ink': props.draft.method === 'GET',
            'text-method-post': props.draft.method === 'POST',
            'text-method-put': props.draft.method === 'PUT',
            'text-method-patch': props.draft.method === 'PATCH',
            'text-coral-ink': props.draft.method === 'DELETE'
          }}
          value={props.draft.method}
          onChange={(event) => updateDraft('method', event.currentTarget.value)}
          aria-label="HTTP method"
          disabled={props.busy}
        >
          <For each={METHODS}>{(method) => <option value={method}>{method}</option>}</For>
        </select>
        <div class="field-control url-control grid min-w-0 content-start">
          <input
            id="request-url"
            class={`url-input mono w-full min-w-0 font-data text-[0.8125rem] placeholder:text-ink-faint aria-invalid:border-coral-line ${CONTROL_CLASS}`}
            value={props.draft.url}
            onInput={(event) => updateDraft('url', event.currentTarget.value)}
            aria-label="Request URL"
            aria-invalid={props.validationErrors?.url ? 'true' : undefined}
            aria-describedby={props.validationErrors?.url ? 'request-url-error' : undefined}
            placeholder="https://api.example.com/resource"
            spellcheck={false}
            disabled={props.busy}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter'
                && !event.ctrlKey
                && !event.metaKey
                && !event.altKey
                && !event.shiftKey
                && !props.busy
                && props.draft.url.trim()
              ) {
                event.preventDefault();
                props.onSend();
              }
            }}
          />
          <FieldError id="request-url-error" message={props.validationErrors?.url} />
        </div>
        <button
          type="button"
          class={`action primary ${ACTION_CLASS} ${PRIMARY_ACTION_CLASS}`}
          onClick={props.onSend}
          disabled={props.busy || !props.draft.url.trim()}
          aria-keyshortcuts="Control+Enter Meta+Enter"
        >
          {props.sending ? 'Sending…' : 'Send'} <kbd class="ml-1 font-data text-[0.6875rem] leading-none font-[650] opacity-72">Ctrl/Command+Enter</kbd>
        </button>
      </div>

      <Tabs
        items={REQUEST_TABS}
        value={tab()}
        onChange={setTab}
        idPrefix="request"
        panelId="request-tabpanel"
        ariaLabel="Request settings"
        class="flex min-h-11 items-end gap-6 border-b border-border-strong bg-raised px-4 max-[36rem]:grid max-[36rem]:min-h-control-default max-[36rem]:grid-cols-4 max-[36rem]:items-stretch max-[36rem]:gap-1 max-[36rem]:px-2"
        buttonClass="hover:text-naval focus-visible:relative focus-visible:z-2 focus-visible:outline-0 focus-visible:[box-shadow:var(--focus-ring)] max-[36rem]:h-control-default max-[36rem]:w-full max-[36rem]:min-w-0 max-[36rem]:text-xs"
      />

      <div class="editor-pane min-h-0 overflow-auto bg-panel p-4 max-[36rem]:p-2" id="request-tabpanel" role="tabpanel" aria-labelledby={`request-tab-${tab()}`}>
        <Show when={tab() === 'query'}>
          <KeyValueEditor
            fill
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
            fill
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
          <SegmentedControl
            items={BODY_MODES.map((mode) => ({ value: mode, label: mode }))}
            value={props.draft.bodyMode}
            onChange={(mode) => updateDraft('bodyMode', mode)}
            ariaLabel="Body mode"
            disabled={props.busy}
            class="mb-3 max-[36rem]:max-w-full max-[36rem]:flex-wrap max-[36rem]:gap-1"
            buttonClass="hover:text-naval focus-visible:relative focus-visible:z-2 focus-visible:outline-0 focus-visible:[box-shadow:var(--focus-ring)] disabled:opacity-48 max-[36rem]:min-w-0 max-[36rem]:flex-[1_1_auto]"
          />
          <Show
            when={props.draft.bodyMode !== 'none'}
            fallback={<div class="pane-empty grid min-h-48 place-content-center gap-2 rounded-md border border-dashed border-hairline text-center text-ink-muted"><strong>No request body</strong><span>Choose text, JSON, or form to attach a payload.</span></div>}
          >
            <div class="field-control body-control grid h-[calc(100%_-_3rem)] min-h-56 min-w-0 content-start grid-rows-[minmax(14rem,1fr)_auto_auto]">
              <textarea
                id="request-body"
                class={`code-editor h-full ${CODE_EDITOR_CLASS}`}
                value={props.draft.body}
                onInput={(event) => updateDraft('body', event.currentTarget.value)}
                aria-label="Request body"
                aria-invalid={props.validationErrors?.body ? 'true' : undefined}
                aria-describedby={props.validationErrors?.body ? 'request-body-error' : undefined}
                spellcheck={false}
                disabled={props.busy}
                placeholder={props.draft.bodyMode === 'json' ? '{\n  "key": "value"\n}' : 'Request payload'}
              />
              <FieldError id="request-body-error" message={props.validationErrors?.body} />
              <Show when={props.draft.bodyMode === 'form'}>
                <p class="editor-help mt-3 text-xs leading-6 text-ink-muted [&_code]:font-data [&_code]:text-coral-ink">Sent as raw URL-encoded text. Enter pairs such as <code>name=owl&amp;active=true</code>.</p>
              </Show>
            </div>
          </Show>
        </Show>
        <Show when={tab() === 'scripts'}>
          <SegmentedControl
            items={SCRIPT_STAGES}
            value={scriptTab()}
            onChange={setScriptTab}
            ariaLabel="Script stage"
            class="mb-3 max-[36rem]:max-w-full max-[36rem]:flex-wrap max-[36rem]:gap-1"
            buttonClass="hover:text-naval focus-visible:relative focus-visible:z-2 focus-visible:outline-0 focus-visible:[box-shadow:var(--focus-ring)] disabled:opacity-48 max-[36rem]:min-w-0 max-[36rem]:flex-[1_1_auto]"
          />
          <Show
            when={scriptTab() === 'pre'}
            fallback={(
              <div class="field-control grid min-w-0 content-start">
                <textarea
                  id="request-post-script"
                  class={`code-editor ${CODE_EDITOR_CLASS}`}
                  value={props.draft.postResponseScript}
                  onInput={(event) => updateDraft('postResponseScript', event.currentTarget.value)}
                  aria-label="Post-response script"
                  aria-invalid={props.validationErrors?.postResponseScript ? 'true' : undefined}
                  aria-describedby={props.validationErrors?.postResponseScript ? 'request-post-script-error' : undefined}
                  spellcheck={false}
                  disabled={props.busy}
                  placeholder="// Return { variables, assertions, logs }"
                />
                <FieldError id="request-post-script-error" message={props.validationErrors?.postResponseScript} />
              </div>
            )}
          >
            <div class="field-control grid min-w-0 content-start">
              <textarea
                id="request-pre-script"
                class={`code-editor ${CODE_EDITOR_CLASS}`}
                value={props.draft.preRequestScript}
                onInput={(event) => updateDraft('preRequestScript', event.currentTarget.value)}
                aria-label="Pre-request script"
                aria-invalid={props.validationErrors?.preRequestScript ? 'true' : undefined}
                aria-describedby={props.validationErrors?.preRequestScript ? 'request-pre-script-error' : undefined}
                spellcheck={false}
                disabled={props.busy}
                placeholder="// Return { request, variables, assertions, logs }"
              />
              <FieldError id="request-pre-script-error" message={props.validationErrors?.preRequestScript} />
            </div>
          </Show>
          <p class="editor-help mt-3 text-xs leading-6 text-ink-muted [&_code]:font-data [&_code]:text-coral-ink">Scripts export <code>main(context)</code> and return an object. Before request, return any of <code>request</code>, <code>variables</code>, <code>assertions</code>, or <code>logs</code>; after response, return <code>variables</code>, <code>assertions</code>, or <code>logs</code>.</p>
        </Show>
      </div>
    </section>
  );
}
