<script lang="ts">
  import type { Environment } from '../types';
  import ActionButton from './ActionButton.svelte';
  import KeyValueEditor from './KeyValueEditor.svelte';

  let {
    draft = $bindable(),
    saving,
    onsave,
    ondelete
  }: {
    draft: Environment;
    saving: boolean;
    onsave: () => void;
    ondelete: () => void;
  } = $props();
  let concealValues = $state(false);
</script>

<section class="entity-editor environment-editor" aria-label="Environment editor">
  <header class="entity-header">
    <div><span class="eyebrow">VARIABLE DECK</span><h1>Environment</h1><p>Variables replace matching <code>{'{{name}}'}</code> tokens when a request is sent.</p></div>
    <div class="toolbar-actions"><ActionButton tone="danger" onclick={ondelete}>Delete</ActionButton><ActionButton tone="primary" disabled={saving} onclick={onsave}>{saving ? 'Saving…' : 'Save environment'}</ActionButton></div>
  </header>
  <label class="stacked-field"><span>Name</span><input class="large-field" bind:value={draft.name} aria-label="Environment name" /></label>
  <div class="section-heading"><div><h2>Variables</h2><p>Disabled variables stay saved but are not substituted.</p></div><label class="toggle-label"><input type="checkbox" bind:checked={concealValues} /> Conceal values</label></div>
  <KeyValueEditor bind:rows={draft.variables} keyLabel="Variable" valueLabel="Value" addLabel="Add variable" secret={concealValues} />
</section>
