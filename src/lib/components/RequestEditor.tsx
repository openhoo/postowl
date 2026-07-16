import { For, Show, createSignal } from 'solid-js';
import type { Collection, RequestDraft } from '../types';
import { BODY_MODES, METHODS } from '../utils';
import ActionButton from './ActionButton';
import KeyValueEditor from './KeyValueEditor';

interface RequestEditorProps {
  draft: RequestDraft;
  collections: Collection[];
  dirty: boolean;
  saving: boolean;
  sending: boolean;
  onDraftChange: (next: RequestDraft) => void;
  onSave: () => void;
  onSend: () => void;
  onDelete: () => void;
}

type RequestTab = 'query' | 'headers' | 'body' | 'scripts';
type ScriptTab = 'pre' | 'post';

export default function RequestEditor(props: RequestEditorProps) {
  const [tab, setTab] = createSignal<RequestTab>('query');
  const [scriptTab, setScriptTab] = createSignal<ScriptTab>('pre');

  const updateDraft = <K extends keyof RequestDraft>(key: K, value: RequestDraft[K]) => {
    props.onDraftChange({ ...props.draft, [key]: value });
  };


  return (
    <section class="request-editor" aria-label="Request editor">
      <header class="editor-titlebar">
        <div class="request-identity">
          <span class="eyebrow">REQUEST {props.dirty ? '• UNSAVED' : '• SAVED'}</span>
          <input
            class="title-input"
            value={props.draft.name}
            onInput={(event) => updateDraft('name', event.currentTarget.value)}
            aria-label="Request name"
          />
        </div>
        <label class="compact-field">
          <span>Collection</span>
          <select
            value={props.draft.collectionId ?? ''}
            onChange={(event) => updateDraft('collectionId', event.currentTarget.value || null)}
            aria-label="Collection"
          >
            <option value="">Unfiled</option>
            <For each={props.collections}>
              {(collection) => <option value={collection.id}>{collection.name}</option>}
            </For>
          </select>
        </label>
        <div class="toolbar-actions">
          <ActionButton onClick={props.onDelete} tone="danger">Delete</ActionButton>
          <ActionButton onClick={props.onSave} disabled={props.saving}>
            {props.saving ? 'Saving…' : 'Save'} <kbd>⌘S</kbd>
          </ActionButton>
        </div>
      </header>

      <div class="request-line">
        <select
          class={`method method-${props.draft.method.toLowerCase()}`}
          value={props.draft.method}
          onChange={(event) => updateDraft('method', event.currentTarget.value)}
          aria-label="HTTP method"
        >
          <For each={METHODS}>{(method) => <option value={method}>{method}</option>}</For>
        </select>
        <input
          class="url-input mono"
          value={props.draft.url}
          onInput={(event) => updateDraft('url', event.currentTarget.value)}
          aria-label="Request URL"
          placeholder="https://api.example.com/resource"
          spellcheck={false}
        />
        <ActionButton tone="primary" onClick={props.onSend} disabled={props.sending || !props.draft.url.trim()}>
          {props.sending ? 'Sending…' : 'Send'} <kbd>⌘↵</kbd>
        </ActionButton>
      </div>

      <nav class="tabs" aria-label="Request settings">
        <For each={['query', 'headers', 'body', 'scripts'] as const}>
          {(item) => (
            <button type="button" classList={{ active: tab() === item }} onClick={() => setTab(item)}>
              {item}
            </button>
          )}
        </For>
      </nav>

      <div class="editor-pane">
        <Show when={tab() === 'query'}>
          <KeyValueEditor
            rows={props.draft.query}
            onRowsChange={(query) => props.onDraftChange({ ...props.draft, query })}
            keyLabel="Parameter"
            valueLabel="Value"
            addLabel="Add parameter"
          />
        </Show>
        <Show when={tab() === 'headers'}>
          <KeyValueEditor
            rows={props.draft.headers}
            onRowsChange={(headers) => props.onDraftChange({ ...props.draft, headers })}
            keyLabel="Header"
            valueLabel="Value"
            addLabel="Add header"
          />
        </Show>
        <Show when={tab() === 'body'}>
          <div class="segmented" aria-label="Body mode">
            <For each={BODY_MODES}>
              {(mode) => (
                <button
                  type="button"
                  classList={{ active: props.draft.bodyMode === mode }}
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
            <textarea
              class="code-editor"
              value={props.draft.body}
              onInput={(event) => updateDraft('body', event.currentTarget.value)}
              aria-label="Request body"
              spellcheck={false}
              placeholder={props.draft.bodyMode === 'json' ? '{\n  "key": "value"\n}' : 'Request payload'}
            />
          </Show>
        </Show>
        <Show when={tab() === 'scripts'}>
          <div class="segmented" aria-label="Script stage">
            <button type="button" classList={{ active: scriptTab() === 'pre' }} onClick={() => setScriptTab('pre')}>Before request</button>
            <button type="button" classList={{ active: scriptTab() === 'post' }} onClick={() => setScriptTab('post')}>After response</button>
          </div>
          <Show
            when={scriptTab() === 'pre'}
            fallback={(
              <textarea
                class="code-editor"
                value={props.draft.postResponseScript}
                onInput={(event) => updateDraft('postResponseScript', event.currentTarget.value)}
                aria-label="Post-response script"
                spellcheck={false}
                placeholder="// Inspect the response, log values, or assert conditions"
              />
            )}
          >
            <textarea
              class="code-editor"
              value={props.draft.preRequestScript}
              onInput={(event) => updateDraft('preRequestScript', event.currentTarget.value)}
              aria-label="Pre-request script"
              spellcheck={false}
              placeholder="// Set variables or adjust the request"
            />
          </Show>
          <p class="editor-help">Scripts run in PostOwl’s sandbox. Use <code>console.log()</code> for the execution log and <code>assert(name, condition, message)</code> for checks.</p>
        </Show>
      </div>
    </section>
  );
}
