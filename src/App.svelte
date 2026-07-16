<script lang="ts">
  import { onMount } from 'svelte';
  import { confirm, open as openFile, save as saveFile } from '@tauri-apps/plugin-dialog';
  import { commands } from './lib/api';
  import type { Collection, Environment, RequestDraft, ResponseData, Workspace } from './lib/types';
  import { clone, displayError, newCollection, newEnvironment, newRequest } from './lib/utils';
  import ActionButton from './lib/components/ActionButton.svelte';
  import EnvironmentEditor from './lib/components/EnvironmentEditor.svelte';
  import RequestEditor from './lib/components/RequestEditor.svelte';
  import ResponsePanel from './lib/components/ResponsePanel.svelte';
  import Sidebar from './lib/components/Sidebar.svelte';

  let workspace = $state<Workspace | null>(null);
  let loading = $state(true);
  let loadError = $state('');
  let mode = $state<'workspace' | 'history' | 'environments'>('workspace');
  let selectedRequestId = $state<string | null>(null);
  let selectedHistoryId = $state<string | null>(null);
  let selectedEnvironmentId = $state<string | null>(null);
  let draft = $state<RequestDraft | null>(null);
  let environmentDraft = $state<Environment | null>(null);
  let response = $state<ResponseData | null>(null);
  let saving = $state(false);
  let sending = $state(false);
  let toast = $state<{ tone: 'good' | 'bad'; text: string } | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  let savedRequest = $derived(workspace?.requests.find((item) => item.id === selectedRequestId) ?? null);
  let dirty = $derived(Boolean(draft && (!savedRequest || JSON.stringify(draft) !== JSON.stringify(savedRequest))));
  let selectedHistory = $derived(workspace?.history.find((item) => item.id === selectedHistoryId) ?? null);

  function notify(text: string, tone: 'good' | 'bad' = 'good') {
    toast = { text, tone };
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast = null, 3200);
  }

  async function loadWorkspace() {
    loading = true;
    loadError = '';
    try {
      workspace = await commands.getWorkspace();
      const firstRequest = workspace.requests[0];
      if (firstRequest) {
        selectedRequestId = firstRequest.id;
        draft = clone(firstRequest);
      }
      selectedEnvironmentId = workspace.environments[0]?.id ?? null;
    } catch (error) {
      loadError = displayError(error);
    } finally {
      loading = false;
    }
  }

  function selectRequest(id: string) {
    const request = workspace?.requests.find((item) => item.id === id);
    if (!request) return;
    mode = 'workspace';
    selectedRequestId = id;
    draft = clone(request);
    response = null;
  }

  async function saveRequest() {
    if (!draft || !workspace || saving) return;
    saving = true;
    try {
      const saved = await commands.saveRequest(clone(draft));
      const index = workspace.requests.findIndex((item) => item.id === saved.id);
      if (index === -1) workspace.requests = [...workspace.requests, saved];
      else workspace.requests[index] = saved;
      draft = clone(saved);
      selectedRequestId = saved.id;
      notify('Request saved');
    } catch (error) {
      notify(displayError(error), 'bad');
    } finally {
      saving = false;
    }
  }

  async function sendRequest() {
    if (!draft || !workspace || sending || !draft.url.trim()) return;
    sending = true;
    response = null;
    try {
      const saved = await commands.saveRequest(clone(draft));
      const index = workspace.requests.findIndex((item) => item.id === saved.id);
      if (index === -1) workspace.requests = [...workspace.requests, saved];
      else workspace.requests[index] = saved;
      draft = clone(saved);
      selectedRequestId = saved.id;
      response = await commands.executeRequest(saved.id, selectedEnvironmentId);
      const refreshed = await commands.getWorkspace();
      workspace.history = refreshed.history;
      notify(response.error ? 'Request completed with an error' : 'Response recorded', response.error ? 'bad' : 'good');
    } catch (error) {
      const message = displayError(error);
      response = { status: null, headers: [], body: '', elapsed: 0, size: 0, truncated: false, assertions: [], logs: [], error: message };
      notify(message, 'bad');
    } finally {
      sending = false;
    }
  }

  async function createCollection() {
    if (!workspace) return;
    try {
      const saved = await commands.saveCollection(newCollection());
      workspace.collections = [...workspace.collections, saved];
      notify('Collection created');
    } catch (error) { notify(displayError(error), 'bad'); }
  }

  async function saveCollection(collection: Collection) {
    if (!workspace || !collection.name.trim()) return;
    try {
      const saved = await commands.saveCollection(clone(collection));
      const index = workspace.collections.findIndex((item) => item.id === saved.id);
      if (index !== -1) workspace.collections[index] = saved;
      notify('Collection renamed');
    } catch (error) { notify(displayError(error), 'bad'); }
  }

  async function deleteCollection(collection: Collection) {
    if (!workspace || !await confirm(`Delete “${collection.name}” and every request inside it?`, { title: 'Delete collection', kind: 'warning' })) return;
    try {
      await commands.deleteCollection(collection.id);
      workspace = await commands.getWorkspace();
      if (selectedRequestId && !workspace.requests.some((item) => item.id === selectedRequestId)) {
        selectedRequestId = null; draft = null; response = null;
      }
      notify('Collection deleted');
    } catch (error) { notify(displayError(error), 'bad'); }
  }

  async function createRequest(collectionId: string | null) {
    if (!workspace) return;
    try {
      const saved = await commands.saveRequest(newRequest(collectionId));
      workspace.requests = [...workspace.requests, saved];
      selectRequest(saved.id);
      notify('Request created');
    } catch (error) { notify(displayError(error), 'bad'); }
  }

  async function deleteRequest(request = draft) {
    if (!workspace || !request || !await confirm(`Delete “${request.name}”?`, { title: 'Delete request', kind: 'warning' })) return;
    try {
      await commands.deleteRequest(request.id);
      workspace.requests = workspace.requests.filter((item) => item.id !== request.id);
      if (selectedRequestId === request.id) {
        const next = workspace.requests[0];
        selectedRequestId = next?.id ?? null;
        draft = next ? clone(next) : null;
        response = null;
      }
      notify('Request deleted');
    } catch (error) { notify(displayError(error), 'bad'); }
  }

  function selectHistory(id: string) {
    mode = 'history';
    selectedHistoryId = id;
  }

  async function clearHistory() {
    if (!workspace || !await confirm('Clear all recorded request history? This cannot be undone.', { title: 'Clear history', kind: 'warning' })) return;
    try {
      await commands.clearHistory();
      workspace.history = [];
      selectedHistoryId = null;
      notify('History cleared');
    } catch (error) { notify(displayError(error), 'bad'); }
  }

  function selectEnvironment(id: string) {
    selectedEnvironmentId = id || null;
    const environment = workspace?.environments.find((item) => item.id === id);
    if (mode === 'environments' && environment) environmentDraft = clone(environment);
  }

  async function createEnvironment() {
    if (!workspace) return;
    try {
      const saved = await commands.saveEnvironment(newEnvironment());
      workspace.environments = [...workspace.environments, saved];
      selectedEnvironmentId = saved.id;
      environmentDraft = clone(saved);
      mode = 'environments';
      notify('Environment created');
    } catch (error) { notify(displayError(error), 'bad'); }
  }

  async function saveEnvironment() {
    if (!workspace || !environmentDraft || saving) return;
    saving = true;
    try {
      const saved = await commands.saveEnvironment(clone(environmentDraft));
      const index = workspace.environments.findIndex((item) => item.id === saved.id);
      if (index === -1) workspace.environments = [...workspace.environments, saved];
      else workspace.environments[index] = saved;
      environmentDraft = clone(saved);
      selectedEnvironmentId = saved.id;
      notify('Environment saved');
    } catch (error) { notify(displayError(error), 'bad'); }
    finally { saving = false; }
  }

  async function deleteEnvironment() {
    if (!workspace || !environmentDraft || !await confirm(`Delete “${environmentDraft.name}”?`, { title: 'Delete environment', kind: 'warning' })) return;
    try {
      await commands.deleteEnvironment(environmentDraft.id);
      workspace.environments = workspace.environments.filter((item) => item.id !== environmentDraft?.id);
      const next = workspace.environments[0];
      selectedEnvironmentId = next?.id ?? null;
      environmentDraft = next ? clone(next) : null;
      notify('Environment deleted');
    } catch (error) { notify(displayError(error), 'bad'); }
  }

  function openEnvironments() {
    mode = 'environments';
    const environment = workspace?.environments.find((item) => item.id === selectedEnvironmentId) ?? workspace?.environments[0];
    environmentDraft = environment ? clone(environment) : null;
  }

  async function exportWorkspace() {
    const path = await saveFile({ title: 'Export PostOwl workspace', defaultPath: 'postowl-workspace.json', filters: [{ name: 'PostOwl workspace', extensions: ['json'] }] });
    if (!path) return;
    try { await commands.exportWorkspace(path); notify('Workspace exported'); }
    catch (error) { notify(displayError(error), 'bad'); }
  }

  async function importWorkspace() {
    const path = await openFile({ title: 'Import PostOwl workspace', multiple: false, directory: false, filters: [{ name: 'PostOwl workspace', extensions: ['json'] }] });
    if (!path || !await confirm('Importing replaces the current workspace. Continue?', { title: 'Import workspace', kind: 'warning' })) return;
    try {
      workspace = await commands.importWorkspace(path);
      selectedRequestId = workspace.requests[0]?.id ?? null;
      draft = workspace.requests[0] ? clone(workspace.requests[0]) : null;
      selectedEnvironmentId = workspace.environments[0]?.id ?? null;
      selectedHistoryId = null;
      response = null;
      mode = 'workspace';
      notify('Workspace imported');
    } catch (error) { notify(displayError(error), 'bad'); }
  }

  onMount(() => {
    void loadWorkspace();
    const handleKeydown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === 'Enter' && mode === 'workspace' && draft) { event.preventDefault(); void sendRequest(); }
      if (event.key.toLowerCase() === 's' && mode === 'workspace' && draft) { event.preventDefault(); void saveRequest(); }
    };
    window.addEventListener('keydown', handleKeydown);
    return () => { window.removeEventListener('keydown', handleKeydown); if (toastTimer) clearTimeout(toastTimer); };
  });
</script>

<svelte:head><title>PostOwl — REST flight recorder</title></svelte:head>

<div class="app-shell">
  <header class="topbar">
    <button class="brand" type="button" onclick={() => mode = 'workspace'} aria-label="Open workspace"><span class="brand-mark">PO</span><span><strong>PostOwl</strong><small>REST FLIGHT RECORDER</small></span></button>
    <div class="topbar-actions">
      <label class="environment-select"><span>Environment</span><select value={selectedEnvironmentId ?? ''} onchange={(event) => selectEnvironment(event.currentTarget.value)} disabled={!workspace?.environments.length}><option value="">No environment</option>{#each workspace?.environments ?? [] as environment}<option value={environment.id}>{environment.name}</option>{/each}</select></label>
      <ActionButton onclick={openEnvironments}>Environments</ActionButton>
      <span class="topbar-rule"></span>
      <ActionButton onclick={importWorkspace}>Import</ActionButton>
      <ActionButton onclick={exportWorkspace} disabled={!workspace}>Export</ActionButton>
    </div>
  </header>

  {#if loading}
    <main class="startup-state"><span class="owl-loader" aria-hidden="true"></span><strong>Opening flight deck</strong><span>Loading your local workspace…</span></main>
  {:else if loadError}
    <main class="startup-state error-state"><strong>Workspace unavailable</strong><span>{loadError}</span><ActionButton tone="primary" onclick={loadWorkspace}>Try again</ActionButton></main>
  {:else if workspace}
    <div class="workspace-shell">
      {#if mode === 'environments'}
        <aside class="sidebar environment-sidebar">
          <div class="sidebar-section-head"><span>ENVIRONMENTS</span><ActionButton onclick={createEnvironment}>＋</ActionButton></div>
          <div class="tree-scroll">{#each workspace.environments as environment}<button class="environment-item" class:active={environment.id === environmentDraft?.id} onclick={() => { selectedEnvironmentId = environment.id; environmentDraft = clone(environment); }}><span class="environment-signal"></span><span><strong>{environment.name}</strong><small>{environment.variables.filter((item) => item.enabled).length} active variables</small></span></button>{:else}<div class="sidebar-empty"><strong>No environments</strong><span>Create one to manage reusable request variables.</span><ActionButton tone="primary" onclick={createEnvironment}>Create environment</ActionButton></div>{/each}</div>
        </aside>
      {:else}
        <Sidebar collections={workspace.collections} requests={workspace.requests} history={workspace.history} {mode} {selectedRequestId} {selectedHistoryId} onmode={(next) => mode = next} onrequest={selectRequest} onhistory={selectHistory} onnewcollection={createCollection} onnewrequest={createRequest} onsavecollection={saveCollection} ondeletecollection={deleteCollection} ondeleterequest={deleteRequest} onclearhistory={clearHistory} />
      {/if}

      <main class="main-stage">
        {#if mode === 'environments'}
          {#if environmentDraft}<EnvironmentEditor bind:draft={environmentDraft} {saving} onsave={saveEnvironment} ondelete={deleteEnvironment} />{:else}<div class="main-empty"><span class="empty-glyph">ENV</span><h1>Build a variable deck</h1><p>Keep host names, tokens, and reusable values separate from requests.</p><ActionButton tone="primary" onclick={createEnvironment}>Create environment</ActionButton></div>{/if}
        {:else if mode === 'history'}
          {#if selectedHistory}
            <div class="history-stage"><header class="history-title"><span class={`method-tag method-${selectedHistory.method.toLowerCase()}`}>{selectedHistory.method}</span><div><span class="eyebrow">RECORDED TRANSMISSION</span><h1>{selectedHistory.requestName}</h1><p class="mono">{selectedHistory.url}</p></div></header><ResponsePanel response={selectedHistory.response} /></div>
          {:else}<div class="main-empty"><span class="empty-glyph">REC</span><h1>Select a recorded request</h1><p>History preserves the exact response and telemetry from each transmission.</p></div>{/if}
        {:else if draft}
          <div class="workbench"><RequestEditor bind:draft collections={workspace.collections} {dirty} {saving} {sending} onsave={saveRequest} onsend={sendRequest} ondelete={() => deleteRequest()} /><ResponsePanel {response} pending={sending} /></div>
        {:else}
          <div class="main-empty"><span class="empty-glyph">HTTP</span><h1>Ready for a request</h1><p>Create a request in a collection or keep it unfiled.</p><ActionButton tone="primary" onclick={() => createRequest(null)}>Create request</ActionButton></div>
        {/if}
      </main>
    </div>
  {/if}

  {#if toast}<div class="toast" class:bad={toast.tone === 'bad'} role="status"><span></span>{toast.text}</div>{/if}
</div>
