import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { confirm, open as openFile, save as saveFile } from '@tauri-apps/plugin-dialog';
import { commands } from './lib/api';
import type { Collection, Environment, RequestDraft, ResponseData, Workspace } from './lib/types';
import { clone, displayError, newCollection, newEnvironment, newRequest } from './lib/utils';
import ActionButton from './lib/components/ActionButton';
import EnvironmentEditor from './lib/components/EnvironmentEditor';
import RequestEditor from './lib/components/RequestEditor';
import ResponsePanel from './lib/components/ResponsePanel';
import Sidebar from './lib/components/Sidebar';

type Mode = 'workspace' | 'history' | 'environments';
type Toast = { tone: 'good' | 'bad'; text: string };

const emptyResponse = (message: string): ResponseData => ({
  status: null,
  headers: [],
  body: '',
  elapsed: 0,
  size: 0,
  truncated: false,
  assertions: [],
  logs: [],
  error: message
});

export default function App() {
  const [workspace, setWorkspace] = createSignal<Workspace | null>(null);
  const [loading, setLoading] = createSignal(true);
  const [loadError, setLoadError] = createSignal('');
  const [mode, setMode] = createSignal<Mode>('workspace');
  const [selectedRequestId, setSelectedRequestId] = createSignal<string | null>(null);
  const [selectedHistoryId, setSelectedHistoryId] = createSignal<string | null>(null);
  const [selectedEnvironmentId, setSelectedEnvironmentId] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal<RequestDraft | null>(null);
  const [environmentDraft, setEnvironmentDraft] = createSignal<Environment | null>(null);
  const [response, setResponse] = createSignal<ResponseData | null>(null);
  const [saving, setSaving] = createSignal(false);
  const [sending, setSending] = createSignal(false);
  const [toast, setToast] = createSignal<Toast | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;

  const savedRequest = createMemo(() => workspace()?.requests.find((item) => item.id === selectedRequestId()) ?? null);
  const dirty = createMemo(() => {
    const current = draft();
    const saved = savedRequest();
    return Boolean(current && (!saved || JSON.stringify(current) !== JSON.stringify(saved)));
  });
  const selectedHistory = createMemo(() => workspace()?.history.find((item) => item.id === selectedHistoryId()) ?? null);

  function notify(text: string, tone: Toast['tone'] = 'good') {
    setToast({ text, tone });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(null), 3200);
  }

  function updateWorkspace(updater: (current: Workspace) => Workspace) {
    setWorkspace((current) => current ? updater(current) : current);
  }

  async function loadWorkspace() {
    setLoading(true);
    setLoadError('');
    try {
      const loaded = await commands.getWorkspace();
      setWorkspace(loaded);
      const firstRequest = loaded.requests[0];
      setSelectedRequestId(firstRequest?.id ?? null);
      setDraft(firstRequest ? clone(firstRequest) : null);
      setSelectedEnvironmentId(loaded.environments[0]?.id ?? null);
    } catch (error) {
      setLoadError(displayError(error));
    } finally {
      setLoading(false);
    }
  }

  function selectRequest(id: string) {
    const request = workspace()?.requests.find((item) => item.id === id);
    if (!request) return;
    setMode('workspace');
    setSelectedRequestId(id);
    setDraft(clone(request));
    setResponse(null);
  }

  async function saveRequest() {
    const current = draft();
    if (!current || !workspace() || saving()) return;
    setSaving(true);
    try {
      const saved = await commands.saveRequest(clone(current));
      updateWorkspace((value) => ({
        ...value,
        requests: value.requests.some((item) => item.id === saved.id)
          ? value.requests.map((item) => item.id === saved.id ? saved : item)
          : [...value.requests, saved]
      }));
      setDraft(clone(saved));
      setSelectedRequestId(saved.id);
      notify('Request saved');
    } catch (error) {
      notify(displayError(error), 'bad');
    } finally {
      setSaving(false);
    }
  }

  async function sendRequest() {
    const current = draft();
    if (!current || !workspace() || sending() || !current.url.trim()) return;
    setSending(true);
    setResponse(null);
    try {
      const saved = await commands.saveRequest(clone(current));
      updateWorkspace((value) => ({
        ...value,
        requests: value.requests.some((item) => item.id === saved.id)
          ? value.requests.map((item) => item.id === saved.id ? saved : item)
          : [...value.requests, saved]
      }));
      setDraft(clone(saved));
      setSelectedRequestId(saved.id);
      const result = await commands.executeRequest(saved.id, selectedEnvironmentId());
      setResponse(result);
      const refreshed = await commands.getWorkspace();
      updateWorkspace((value) => ({ ...value, history: refreshed.history }));
      notify(result.error ? 'Request completed with an error' : 'Response recorded', result.error ? 'bad' : 'good');
    } catch (error) {
      const message = displayError(error);
      setResponse(emptyResponse(message));
      notify(message, 'bad');
    } finally {
      setSending(false);
    }
  }

  async function createCollection() {
    if (!workspace()) return;
    try {
      const saved = await commands.saveCollection(newCollection());
      updateWorkspace((value) => ({ ...value, collections: [...value.collections, saved] }));
      notify('Collection created');
    } catch (error) { notify(displayError(error), 'bad'); }
  }

  async function saveCollection(collection: Collection) {
    if (!workspace() || !collection.name.trim()) return;
    try {
      const saved = await commands.saveCollection(clone(collection));
      updateWorkspace((value) => ({
        ...value,
        collections: value.collections.map((item) => item.id === saved.id ? saved : item)
      }));
      notify('Collection renamed');
    } catch (error) { notify(displayError(error), 'bad'); }
  }

  async function deleteCollection(collection: Collection) {
    if (!workspace() || !await confirm(`Delete “${collection.name}” and every request inside it?`, { title: 'Delete collection', kind: 'warning' })) return;
    try {
      await commands.deleteCollection(collection.id);
      const refreshed = await commands.getWorkspace();
      setWorkspace(refreshed);
      if (selectedRequestId() && !refreshed.requests.some((item) => item.id === selectedRequestId())) {
        setSelectedRequestId(null);
        setDraft(null);
        setResponse(null);
      }
      notify('Collection deleted');
    } catch (error) { notify(displayError(error), 'bad'); }
  }

  async function createRequest(collectionId: string | null) {
    if (!workspace()) return;
    try {
      const saved = await commands.saveRequest(newRequest(collectionId));
      updateWorkspace((value) => ({ ...value, requests: [...value.requests, saved] }));
      selectRequest(saved.id);
      notify('Request created');
    } catch (error) { notify(displayError(error), 'bad'); }
  }

  async function deleteRequest(request = draft()) {
    if (!workspace() || !request || !await confirm(`Delete “${request.name}”?`, { title: 'Delete request', kind: 'warning' })) return;
    try {
      await commands.deleteRequest(request.id);
      const requests = workspace()!.requests.filter((item) => item.id !== request.id);
      updateWorkspace((value) => ({ ...value, requests }));
      if (selectedRequestId() === request.id) {
        const next = requests[0];
        setSelectedRequestId(next?.id ?? null);
        setDraft(next ? clone(next) : null);
        setResponse(null);
      }
      notify('Request deleted');
    } catch (error) { notify(displayError(error), 'bad'); }
  }

  function selectHistory(id: string) {
    setMode('history');
    setSelectedHistoryId(id);
  }

  async function clearHistory() {
    if (!workspace() || !await confirm('Clear all recorded request history? This cannot be undone.', { title: 'Clear history', kind: 'warning' })) return;
    try {
      await commands.clearHistory();
      updateWorkspace((value) => ({ ...value, history: [] }));
      setSelectedHistoryId(null);
      notify('History cleared');
    } catch (error) { notify(displayError(error), 'bad'); }
  }

  function selectEnvironment(id: string) {
    setSelectedEnvironmentId(id || null);
    const environment = workspace()?.environments.find((item) => item.id === id);
    if (mode() === 'environments' && environment) setEnvironmentDraft(clone(environment));
  }

  async function createEnvironment() {
    if (!workspace()) return;
    try {
      const saved = await commands.saveEnvironment(newEnvironment());
      updateWorkspace((value) => ({ ...value, environments: [...value.environments, saved] }));
      setSelectedEnvironmentId(saved.id);
      setEnvironmentDraft(clone(saved));
      setMode('environments');
      notify('Environment created');
    } catch (error) { notify(displayError(error), 'bad'); }
  }

  async function saveEnvironment() {
    const current = environmentDraft();
    if (!workspace() || !current || saving()) return;
    setSaving(true);
    try {
      const saved = await commands.saveEnvironment(clone(current));
      updateWorkspace((value) => ({
        ...value,
        environments: value.environments.some((item) => item.id === saved.id)
          ? value.environments.map((item) => item.id === saved.id ? saved : item)
          : [...value.environments, saved]
      }));
      setEnvironmentDraft(clone(saved));
      setSelectedEnvironmentId(saved.id);
      notify('Environment saved');
    } catch (error) { notify(displayError(error), 'bad'); }
    finally { setSaving(false); }
  }

  async function deleteEnvironment() {
    const current = environmentDraft();
    if (!workspace() || !current || !await confirm(`Delete “${current.name}”?`, { title: 'Delete environment', kind: 'warning' })) return;
    try {
      await commands.deleteEnvironment(current.id);
      const environments = workspace()!.environments.filter((item) => item.id !== current.id);
      updateWorkspace((value) => ({ ...value, environments }));
      const next = environments[0];
      setSelectedEnvironmentId(next?.id ?? null);
      setEnvironmentDraft(next ? clone(next) : null);
      notify('Environment deleted');
    } catch (error) { notify(displayError(error), 'bad'); }
  }

  function openEnvironments() {
    setMode('environments');
    const environment = workspace()?.environments.find((item) => item.id === selectedEnvironmentId()) ?? workspace()?.environments[0];
    setEnvironmentDraft(environment ? clone(environment) : null);
  }

  async function exportWorkspace() {
    const path = await saveFile({ title: 'Export PostOwl workspace', defaultPath: 'postowl-workspace.json', filters: [{ name: 'PostOwl workspace', extensions: ['json'] }] });
    if (!path) return;
    try { await commands.exportWorkspace(path); notify('Workspace exported'); }
    catch (error) { notify(displayError(error), 'bad'); }
  }

  async function importWorkspace() {
    const selected = await openFile({ title: 'Import PostOwl workspace', multiple: false, directory: false, filters: [{ name: 'PostOwl workspace', extensions: ['json'] }] });
    const path = Array.isArray(selected) ? selected[0] : selected;
    if (!path || !await confirm('Importing replaces the current workspace. Continue?', { title: 'Import workspace', kind: 'warning' })) return;
    try {
      const imported = await commands.importWorkspace(path);
      setWorkspace(imported);
      setSelectedRequestId(imported.requests[0]?.id ?? null);
      setDraft(imported.requests[0] ? clone(imported.requests[0]) : null);
      setSelectedEnvironmentId(imported.environments[0]?.id ?? null);
      setSelectedHistoryId(null);
      setResponse(null);
      setMode('workspace');
      notify('Workspace imported');
    } catch (error) { notify(displayError(error), 'bad'); }
  }

  onMount(() => {
    document.title = 'PostOwl — REST flight recorder';
    void loadWorkspace();
    const handleKeydown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === 'Enter' && mode() === 'workspace' && draft()) { event.preventDefault(); void sendRequest(); }
      if (event.key.toLowerCase() === 's' && mode() === 'workspace' && draft()) { event.preventDefault(); void saveRequest(); }
    };
    window.addEventListener('keydown', handleKeydown);
    onCleanup(() => {
      window.removeEventListener('keydown', handleKeydown);
      clearTimeout(toastTimer);
    });
  });

  return (
    <div class="app-shell">
      <header class="topbar">
        <button class="brand" type="button" onClick={() => setMode('workspace')} aria-label="Open workspace">
          <span class="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span><strong>PostOwl</strong><small>Request observatory</small></span>
        </button>
        <div class="topbar-actions">
          <label class="environment-select">
            <span>Environment</span>
            <select value={selectedEnvironmentId() ?? ''} onChange={(event) => selectEnvironment(event.currentTarget.value)} disabled={!workspace()?.environments.length}>
              <option value="">No environment</option>
              <For each={workspace()?.environments ?? []}>{(environment) => <option value={environment.id}>{environment.name}</option>}</For>
            </select>
          </label>
          <ActionButton onClick={openEnvironments}>Environments</ActionButton>
          <span class="topbar-rule" />
          <ActionButton onClick={() => void importWorkspace()}>Import</ActionButton>
          <ActionButton onClick={() => void exportWorkspace()} disabled={!workspace()}>Export</ActionButton>
        </div>
      </header>

      <Show when={!loading()} fallback={<main class="startup-state"><span class="owl-loader" aria-hidden="true" /><strong>Opening observatory</strong><span>Loading your local workspace…</span></main>}>
        <Show when={!loadError()} fallback={<main class="startup-state error-state"><strong>Workspace unavailable</strong><span>{loadError()}</span><ActionButton tone="primary" onClick={() => void loadWorkspace()}>Try again</ActionButton></main>}>
          <Show when={workspace()}>{(currentWorkspace) => (
            <div class="workspace-shell">
              <Show when={mode() === 'environments'} fallback={
                <Sidebar
                  collections={currentWorkspace().collections}
                  requests={currentWorkspace().requests}
                  history={currentWorkspace().history}
                  mode={mode() === 'history' ? 'history' : 'workspace'}
                  selectedRequestId={selectedRequestId()}
                  selectedHistoryId={selectedHistoryId()}
                  onMode={setMode}
                  onRequest={selectRequest}
                  onHistory={selectHistory}
                  onNewCollection={() => void createCollection()}
                  onNewRequest={(collectionId) => void createRequest(collectionId)}
                  onSaveCollection={(collection) => void saveCollection(collection)}
                  onDeleteCollection={(collection) => void deleteCollection(collection)}
                  onDeleteRequest={(request) => void deleteRequest(request)}
                  onClearHistory={() => void clearHistory()}
                />
              }>
                <aside class="sidebar environment-sidebar">
                  <div class="sidebar-section-head"><span>Environments</span><ActionButton onClick={() => void createEnvironment()}>＋</ActionButton></div>
                  <div class="tree-scroll">
                    <For each={currentWorkspace().environments} fallback={<div class="sidebar-empty"><strong>No environments</strong><span>Create one to manage reusable request variables.</span><ActionButton tone="primary" onClick={() => void createEnvironment()}>Create environment</ActionButton></div>}>
                      {(environment) => <button class="environment-item" classList={{ active: environment.id === environmentDraft()?.id }} onClick={() => { setSelectedEnvironmentId(environment.id); setEnvironmentDraft(clone(environment)); }}><span class="environment-signal" /><span><strong>{environment.name}</strong><small>{environment.variables.filter((item) => item.enabled).length} active variables</small></span></button>}
                    </For>
                  </div>
                </aside>
              </Show>

              <main class="main-stage">
                <Show when={mode() === 'environments'} fallback={
                  <Show when={mode() === 'history'} fallback={
                    <Show when={draft()} fallback={<div class="main-empty"><span class="empty-glyph">HTTP</span><h1>Ready for a request</h1><p>Create a request in a collection or keep it unfiled.</p><ActionButton tone="primary" onClick={() => void createRequest(null)}>Create request</ActionButton></div>}>
                      <div class="workbench"><RequestEditor draft={draft()!} onDraftChange={setDraft} collections={currentWorkspace().collections} dirty={dirty()} saving={saving()} sending={sending()} onSave={() => void saveRequest()} onSend={() => void sendRequest()} onDelete={() => void deleteRequest()} /><ResponsePanel response={response()} pending={sending()} /></div>
                    </Show>
                  }>
                    <Show when={selectedHistory()} keyed fallback={<div class="main-empty"><span class="empty-glyph">REC</span><h1>Select a recorded request</h1><p>History preserves the exact response and telemetry from each transmission.</p></div>}>
                      {(entry) => <div class="history-stage"><header class="history-title"><span class={`method-tag method-${entry.method.toLowerCase()}`}>{entry.method}</span><div><span class="eyebrow">Recorded transmission</span><h1>{entry.requestName}</h1><p class="mono">{entry.url}</p></div></header><ResponsePanel response={entry.response} /></div>}
                    </Show>
                  </Show>
                }>
                  <Show when={environmentDraft()} fallback={<div class="main-empty"><span class="empty-glyph">ENV</span><h1>Build a variable deck</h1><p>Keep host names and reusable values separate from requests.</p><ActionButton tone="primary" onClick={() => void createEnvironment()}>Create environment</ActionButton></div>}>
                    <EnvironmentEditor draft={environmentDraft()!} onDraftChange={setEnvironmentDraft} saving={saving()} onSave={() => void saveEnvironment()} onDelete={() => void deleteEnvironment()} />
                  </Show>
                </Show>
              </main>
            </div>
          )}</Show>
        </Show>
      </Show>

      <Show when={toast()} keyed>{(currentToast) => <div class="toast" classList={{ bad: currentToast.tone === 'bad' }} role="status"><span />{currentToast.text}</div>}</Show>
    </div>
  );
}
