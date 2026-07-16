<script lang="ts">
  import type { ResponseData } from '../types';
  import { formatBytes, statusTone } from '../utils';

  let { response, pending = false }: { response: ResponseData | null; pending?: boolean } = $props();
  let tab = $state<'body' | 'headers' | 'assertions' | 'logs'>('body');
  let prettyBody = $derived.by(() => {
    if (!response?.body) return '';
    try { return JSON.stringify(JSON.parse(response.body), null, 2); } catch { return response.body; }
  });
  let passedCount = $derived(response?.assertions.filter((item) => item.passed).length ?? 0);
</script>

<section class="response-panel" aria-label="Response">
  <header class="response-heading">
    <div><span class="eyebrow">RESPONSE RECORDER</span><h2>Telemetry</h2></div>
    {#if response?.truncated}<span class="warning-chip">Body truncated</span>{/if}
  </header>

  {#if pending}
    <div class="response-loading" aria-live="polite"><span class="activity-line"></span><strong>Request in flight</strong><span>Waiting for the remote host…</span></div>
  {:else if !response}
    <div class="response-empty"><div class="radar" aria-hidden="true"></div><strong>No transmission yet</strong><span>Send the request to record status, timing, payload, and script output.</span></div>
  {:else}
    <div class="telemetry-strip" data-tone={statusTone(response.status)} aria-label="Response telemetry">
      <div><span>Status</span><strong>{response.status ?? 'ERR'}</strong></div>
      <div><span>Elapsed</span><strong>{response.elapsed} <small>ms</small></strong></div>
      <div><span>Transfer</span><strong>{formatBytes(response.size)}</strong></div>
      <div><span>Checks</span><strong>{passedCount}<small>/{response.assertions.length}</small></strong></div>
    </div>

    {#if response.error}
      <div class="error-banner" role="alert"><strong>Request failed</strong><span>{response.error}</span></div>
    {/if}

    <nav class="tabs response-tabs" aria-label="Response details">
      {#each ['body', 'headers', 'assertions', 'logs'] as item}
        <button type="button" class:active={tab === item} onclick={() => tab = item as typeof tab}>
          {item}{item === 'headers' ? ` ${response.headers.length}` : item === 'assertions' ? ` ${response.assertions.length}` : item === 'logs' ? ` ${response.logs.length}` : ''}
        </button>
      {/each}
    </nav>

    <div class="response-content">
      {#if tab === 'body'}
        {#if prettyBody}<pre class="response-body">{prettyBody}</pre>{:else}<p class="inline-empty">The response body is empty.</p>{/if}
      {:else if tab === 'headers'}
        {#if response.headers.length}
          <dl class="header-list">{#each response.headers as header}<div><dt>{header.name}</dt><dd>{header.value}</dd></div>{/each}</dl>
        {:else}<p class="inline-empty">No response headers were recorded.</p>{/if}
      {:else if tab === 'assertions'}
        {#if response.assertions.length}
          <ul class="assertion-list">{#each response.assertions as assertion}<li class:passed={assertion.passed}><span>{assertion.passed ? 'PASS' : 'FAIL'}</span><div><strong>{assertion.name}</strong>{#if assertion.message}<p>{assertion.message}</p>{/if}</div></li>{/each}</ul>
        {:else}<p class="inline-empty">No assertions ran. Add checks in the after-response script.</p>{/if}
      {:else}
        {#if response.logs.length}<ol class="log-list">{#each response.logs as log, index}<li><span>{String(index + 1).padStart(2, '0')}</span><code>{log}</code></li>{/each}</ol>{:else}<p class="inline-empty">No script logs were recorded.</p>{/if}
      {/if}
    </div>
  {/if}
</section>
