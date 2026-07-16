<script lang="ts">
  import type { Collection, RequestDraft } from '../types';
  import { BODY_MODES, METHODS } from '../utils';
  import ActionButton from './ActionButton.svelte';
  import KeyValueEditor from './KeyValueEditor.svelte';

  let {
    draft = $bindable(),
    collections,
    dirty,
    saving,
    sending,
    onsave,
    onsend,
    ondelete
  }: {
    draft: RequestDraft;
    collections: Collection[];
    dirty: boolean;
    saving: boolean;
    sending: boolean;
    onsave: () => void;
    onsend: () => void;
    ondelete: () => void;
  } = $props();

  let tab = $state<'query' | 'headers' | 'body' | 'scripts'>('query');
  let scriptTab = $state<'pre' | 'post'>('pre');
</script>

<section class="request-editor" aria-label="Request editor">
  <header class="editor-titlebar">
    <div class="request-identity">
      <span class="eyebrow">REQUEST {dirty ? '• UNSAVED' : '• SAVED'}</span>
      <input class="title-input" bind:value={draft.name} aria-label="Request name" />
    </div>
    <label class="compact-field">
      <span>Collection</span>
      <select bind:value={draft.collectionId} aria-label="Collection">
        <option value={null}>Unfiled</option>
        {#each collections as collection}
          <option value={collection.id}>{collection.name}</option>
        {/each}
      </select>
    </label>
    <div class="toolbar-actions">
      <ActionButton onclick={ondelete} tone="danger">Delete</ActionButton>
      <ActionButton onclick={onsave} disabled={saving}>{saving ? 'Saving…' : 'Save'} <kbd>⌘S</kbd></ActionButton>
    </div>
  </header>

  <div class="request-line">
    <select class={`method method-${draft.method.toLowerCase()}`} bind:value={draft.method} aria-label="HTTP method">
      {#each METHODS as method}<option value={method}>{method}</option>{/each}
    </select>
    <input class="url-input mono" bind:value={draft.url} aria-label="Request URL" placeholder="https://api.example.com/resource" spellcheck="false" />
    <ActionButton tone="primary" onclick={onsend} disabled={sending || !draft.url.trim()}>{sending ? 'Sending…' : 'Send'} <kbd>⌘↵</kbd></ActionButton>
  </div>

  <nav class="tabs" aria-label="Request settings">
    {#each ['query', 'headers', 'body', 'scripts'] as item}
      <button type="button" class:active={tab === item} onclick={() => tab = item as typeof tab}>{item}</button>
    {/each}
  </nav>

  <div class="editor-pane">
    {#if tab === 'query'}
      <KeyValueEditor bind:rows={draft.query} keyLabel="Parameter" valueLabel="Value" addLabel="Add parameter" />
    {:else if tab === 'headers'}
      <KeyValueEditor bind:rows={draft.headers} keyLabel="Header" valueLabel="Value" addLabel="Add header" />
    {:else if tab === 'body'}
      <div class="segmented" aria-label="Body mode">
        {#each BODY_MODES as mode}
          <button type="button" class:active={draft.bodyMode === mode} onclick={() => draft.bodyMode = mode}>{mode}</button>
        {/each}
      </div>
      {#if draft.bodyMode === 'none'}
        <div class="pane-empty"><strong>No request body</strong><span>Choose text, JSON, or form to attach a payload.</span></div>
      {:else}
        <textarea class="code-editor" bind:value={draft.body} aria-label="Request body" spellcheck="false" placeholder={draft.bodyMode === 'json' ? '{\n  "key": "value"\n}' : 'Request payload'}></textarea>
      {/if}
    {:else}
      <div class="segmented" aria-label="Script stage">
        <button type="button" class:active={scriptTab === 'pre'} onclick={() => scriptTab = 'pre'}>Before request</button>
        <button type="button" class:active={scriptTab === 'post'} onclick={() => scriptTab = 'post'}>After response</button>
      </div>
      {#if scriptTab === 'pre'}
        <textarea class="code-editor" bind:value={draft.preRequestScript} aria-label="Pre-request script" spellcheck="false" placeholder="// Set variables or adjust the request"></textarea>
      {:else}
        <textarea class="code-editor" bind:value={draft.postResponseScript} aria-label="Post-response script" spellcheck="false" placeholder="// Inspect the response, log values, or assert conditions"></textarea>
      {/if}
      <p class="editor-help">Scripts run in PostOwl’s sandbox. Use <code>console.log()</code> for the execution log and <code>assert(name, condition, message)</code> for checks.</p>
    {/if}
  </div>
</section>
