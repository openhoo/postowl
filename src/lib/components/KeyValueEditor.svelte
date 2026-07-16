<script lang="ts">
  import type { NamedValue } from '../types';
  import { namedValue } from '../utils';
  import ActionButton from './ActionButton.svelte';

  let {
    rows = $bindable(),
    keyLabel = 'Key',
    valueLabel = 'Value',
    addLabel = 'Add row',
    secret = false
  }: {
    rows: NamedValue[];
    keyLabel?: string;
    valueLabel?: string;
    addLabel?: string;
    secret?: boolean;
  } = $props();

  function removeRow(id: string) {
    rows = rows.filter((row) => row.id !== id);
  }

  function appendRow() {
    rows = [...rows, namedValue()];
  }
</script>

<div class="kv-editor">
  <div class="kv-head" aria-hidden="true"><span>On</span><span>{keyLabel}</span><span>{valueLabel}</span><span></span></div>
  {#each rows as row (row.id)}
    <div class="kv-row">
      <label class="check-cell" title="Enable row"><input type="checkbox" bind:checked={row.enabled} aria-label={`Enable ${row.name || 'row'}`} /></label>
      <input class="mono" bind:value={row.name} aria-label={keyLabel} placeholder={keyLabel} />
      <input class="mono" type={secret ? 'password' : 'text'} bind:value={row.value} aria-label={valueLabel} placeholder={valueLabel} />
      <button class="icon-button" type="button" aria-label="Remove row" title="Remove row" onclick={() => removeRow(row.id)}>×</button>
    </div>
  {:else}
    <p class="inline-empty">No rows. Add one when this request needs it.</p>
  {/each}
  <ActionButton onclick={appendRow}>＋ {addLabel}</ActionButton>
</div>
