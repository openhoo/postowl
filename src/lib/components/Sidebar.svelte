<script lang="ts">
  import type { Collection, HistoryEntry, RequestDraft } from '../types';
  import { formatTime } from '../utils';
  import ActionButton from './ActionButton.svelte';

  let {
    collections,
    requests,
    history,
    mode,
    selectedRequestId,
    selectedHistoryId,
    onmode,
    onrequest,
    onhistory,
    onnewcollection,
    onnewrequest,
    onsavecollection,
    ondeletecollection,
    ondeleterequest,
    onclearhistory
  }: {
    collections: Collection[];
    requests: RequestDraft[];
    history: HistoryEntry[];
    mode: 'workspace' | 'history' | 'environments';
    selectedRequestId: string | null;
    selectedHistoryId: string | null;
    onmode: (mode: 'workspace' | 'history') => void;
    onrequest: (id: string) => void;
    onhistory: (id: string) => void;
    onnewcollection: () => void;
    onnewrequest: (collectionId: string | null) => void;
    onsavecollection: (collection: Collection) => void;
    ondeletecollection: (collection: Collection) => void;
    ondeleterequest: (request: RequestDraft) => void;
    onclearhistory: () => void;
  } = $props();

  let expanded = $state<Record<string, boolean>>({});
</script>

<aside class="sidebar">
  <nav class="sidebar-tabs" aria-label="Workspace navigation">
    <button class:active={mode === 'workspace'} onclick={() => onmode('workspace')}>Workspace</button>
    <button class:active={mode === 'history'} onclick={() => onmode('history')}>History</button>
  </nav>

  {#if mode === 'history'}
    <div class="sidebar-section-head"><span>{history.length} RECORDS</span>{#if history.length}<button onclick={onclearhistory}>Clear</button>{/if}</div>
    <div class="tree-scroll">
      {#each history as entry (entry.id)}
        <button class="history-item" class:active={entry.id === selectedHistoryId} onclick={() => onhistory(entry.id)}>
          <span class={`method-tag method-${entry.method.toLowerCase()}`}>{entry.method}</span>
          <span class="history-copy"><strong>{entry.requestName}</strong><small>{entry.response.status ?? 'ERR'} · {formatTime(entry.executedAt)}</small></span>
        </button>
      {:else}
        <div class="sidebar-empty"><strong>No recorded flights</strong><span>Completed requests appear here and persist across restarts.</span></div>
      {/each}
    </div>
  {:else}
    <div class="sidebar-section-head"><span>COLLECTIONS</span><ActionButton onclick={onnewcollection} title="New collection">＋</ActionButton></div>
    <div class="tree-scroll">
      {#each collections as collection (collection.id)}
        <section class="collection-node">
          <div class="collection-row">
            <button class="disclosure" aria-label={`${expanded[collection.id] === false ? 'Expand' : 'Collapse'} ${collection.name}`} onclick={() => expanded[collection.id] = expanded[collection.id] === false}>▾</button>
            <input bind:value={collection.name} aria-label="Collection name" onblur={() => onsavecollection(collection)} onkeydown={(event) => event.key === 'Enter' && event.currentTarget.blur()} />
            <button class="icon-button" title="New request" aria-label={`New request in ${collection.name}`} onclick={() => onnewrequest(collection.id)}>＋</button>
            <button class="icon-button danger-icon" title="Delete collection" aria-label={`Delete ${collection.name}`} onclick={() => ondeletecollection(collection)}>×</button>
          </div>
          {#if expanded[collection.id] !== false}
            <div class="request-tree">
              {#each requests.filter((request) => request.collectionId === collection.id) as request (request.id)}
                <div class="tree-request" class:active={request.id === selectedRequestId}>
                  <button onclick={() => onrequest(request.id)}><span class={`method-dot method-${request.method.toLowerCase()}`}></span><span>{request.name}</span></button>
                  <button class="icon-button danger-icon" aria-label={`Delete ${request.name}`} title="Delete request" onclick={() => ondeleterequest(request)}>×</button>
                </div>
              {:else}<button class="add-first" onclick={() => onnewrequest(collection.id)}>＋ Add first request</button>{/each}
            </div>
          {/if}
        </section>
      {/each}

      <section class="collection-node unfiled">
        <div class="collection-row"><span class="disclosure">⌁</span><span class="collection-label">Unfiled</span><button class="icon-button" title="New unfiled request" aria-label="New unfiled request" onclick={() => onnewrequest(null)}>＋</button></div>
        <div class="request-tree">
          {#each requests.filter((request) => request.collectionId === null) as request (request.id)}
            <div class="tree-request" class:active={request.id === selectedRequestId}>
              <button onclick={() => onrequest(request.id)}><span class={`method-dot method-${request.method.toLowerCase()}`}></span><span>{request.name}</span></button>
              <button class="icon-button danger-icon" aria-label={`Delete ${request.name}`} title="Delete request" onclick={() => ondeleterequest(request)}>×</button>
            </div>
          {:else}<button class="add-first" onclick={() => onnewrequest(null)}>＋ New request</button>{/each}
        </div>
      </section>
    </div>
  {/if}
</aside>
