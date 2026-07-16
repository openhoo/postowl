import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { confirm, open as openFile, save as saveFile } from '@tauri-apps/plugin-dialog';
import { commands } from './lib/api';
import type { Collection, Environment, RequestDraft, ResponseData, Workspace } from './lib/types';
import { clone, displayError, newCollection, newEnvironment, newRequest } from './lib/utils';
import ActionButton from './lib/components/ActionButton';
import EnvironmentEditor, { type EnvironmentValidationErrors } from './lib/components/EnvironmentEditor';
import RequestEditor, { type RequestEditorValidationController } from './lib/components/RequestEditor';
import ResponsePanel from './lib/components/ResponsePanel';
import Sidebar from './lib/components/Sidebar';
import { validateRequestDraft, type RequestValidationErrors } from './lib/validation';

type Mode = 'workspace' | 'history' | 'environments';
type Toast = { tone: 'good' | 'bad'; text: string };
const MAX_ENVIRONMENT_ROWS = 10_000;
const MAX_NAME_BYTES = 1_024;
const MAX_VALUE_BYTES = 1_048_576;
const MAX_ID_BYTES = 256;
const byteLength = (value: string) => new TextEncoder().encode(value).length;
const validId = (value: string) => value === value.trim() && byteLength(value) >= 1 && byteLength(value) <= MAX_ID_BYTES;

const emptyResponse = (message: string): ResponseData => ({
  status: null,
  headers: [],
  body: '',
  bodyEncoding: 'utf8',
  elapsed: 0,
  size: 0,
  totalSize: null,
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
  const [deleting, setDeleting] = createSignal(false);
  const [requestValidationErrors, setRequestValidationErrors] = createSignal<RequestValidationErrors>({});
  const [toast, setToast] = createSignal<Toast | null>(null);
  const [requestPaneWidth, setRequestPaneWidth] = createSignal(55);
  const [transferring, setTransferring] = createSignal(false);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let requestValidationController: RequestEditorValidationController | undefined;

  const savedRequest = createMemo(() => workspace()?.requests.find((item) => item.id === selectedRequestId()) ?? null);
  const dirty = createMemo(() => {
    const current = draft();
    const saved = savedRequest();
    return Boolean(current && (!saved || JSON.stringify(current) !== JSON.stringify(saved)));
  });
  const savedEnvironment = createMemo(() => workspace()?.environments.find((item) => item.id === environmentDraft()?.id) ?? null);
  const environmentDirty = createMemo(() => {
    const current = environmentDraft();
    const saved = savedEnvironment();
    return Boolean(current && (!saved || JSON.stringify(current) !== JSON.stringify(saved)));
  });
  const environmentValidationErrors = createMemo<EnvironmentValidationErrors>(() => {
    const current = environmentDraft();
    if (!current) return {};
    const errors: EnvironmentValidationErrors = {};
    const trimmedName = current.name.trim();
    if (!trimmedName) errors.name = 'Enter an environment name.';
    else if (byteLength(trimmedName) > MAX_NAME_BYTES) errors.name = `Environment name exceeds ${MAX_NAME_BYTES} bytes.`;
    if (!validId(current.id)) errors.summary = `Environment ID must be trimmed and contain 1 to ${MAX_ID_BYTES} bytes.`;
    if (current.variables.length > MAX_ENVIRONMENT_ROWS) errors.summary = `Environment contains more than ${MAX_ENVIRONMENT_ROWS} variables.`;

    const variables: NonNullable<EnvironmentValidationErrors['variables']> = {};
    const enabledNames = new Map<string, string>();
    const rowIds = new Set<string>();
    for (const variable of current.variables) {
      const rowErrors: { name?: string; value?: string } = {};
      if (!validId(variable.id)) rowErrors.name = `Row ID must be trimmed and contain 1 to ${MAX_ID_BYTES} bytes.`;
      else if (rowIds.has(variable.id)) rowErrors.name = 'Row IDs must be unique.';
      rowIds.add(variable.id);
      const name = variable.name.trim();
      if (variable.enabled && !name) rowErrors.name = 'Enter a variable name.';
      else if (byteLength(name) > MAX_NAME_BYTES) rowErrors.name = `Variable name exceeds ${MAX_NAME_BYTES} bytes.`;
      if (byteLength(variable.value) > MAX_VALUE_BYTES) rowErrors.value = `Variable value exceeds ${MAX_VALUE_BYTES} bytes.`;
      if (variable.enabled && name) {
        const existingId = enabledNames.get(name);
        if (existingId) {
          variables[existingId] = { ...variables[existingId], name: 'Enabled variable names must be unique.' };
          rowErrors.name = 'Enabled variable names must be unique.';
        } else {
          enabledNames.set(name, variable.id);
        }
      }
      if (rowErrors.name || rowErrors.value) variables[variable.id] = { ...variables[variable.id], ...rowErrors };
    }
    if (Object.keys(variables).length) errors.variables = variables;
    return errors;
  });
  const hasEnvironmentValidationErrors = createMemo(() => (
    Boolean(environmentValidationErrors().name || environmentValidationErrors().summary)
    || Object.keys(environmentValidationErrors().variables ?? {}).length > 0
  ));
  const requestBusy = createMemo(() => saving() || sending() || deleting());
  const selectedHistory = createMemo(() => workspace()?.history.find((item) => item.id === selectedHistoryId()) ?? null);

  function notify(text: string, tone: Toast['tone'] = 'good') {
    setToast({ text, tone });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => setToast(null), 3200);
  }

  function updateWorkspace(updater: (current: Workspace) => Workspace) {
    setWorkspace((current) => current ? updater(current) : current);
  }

  function hasRequestValidationErrors(errors: RequestValidationErrors) {
    return Boolean(
      errors.summary || errors.name || errors.url || errors.body ||
      errors.preRequestScript || errors.postResponseScript ||
      Object.keys(errors.query ?? {}).length || Object.keys(errors.headers ?? {}).length
    );
  }

  function updateRequestDraft(next: RequestDraft) {
    const current = draft();
    if (response() && current && JSON.stringify(current) !== JSON.stringify(next)) setResponse(null);
    setDraft(next);
    if (hasRequestValidationErrors(requestValidationErrors())) {
      setRequestValidationErrors(validateRequestDraft(next));
    }
  }

  function validateCurrentRequest(current: RequestDraft) {
    const errors = validateRequestDraft(current);
    setRequestValidationErrors(errors);
    if (!hasRequestValidationErrors(errors)) return true;
    queueMicrotask(() => requestValidationController?.focusFirstInvalid());
    return false;
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
      setRequestValidationErrors({});
      setSelectedEnvironmentId(null);
    } catch (error) {
      setLoadError(displayError(error));
    } finally {
      setLoading(false);
    }
  }

  async function canDiscardRequestChanges() {
    return !dirty() || await confirm('Discard the unsaved changes to this request?', {
      title: 'Unsaved request',
      kind: 'warning'
    });
  }

  async function canDiscardEnvironmentChanges() {
    if (!environmentDirty()) return true;
    const discard = await confirm('Discard the unsaved changes to this environment?', {
      title: 'Unsaved environment',
      kind: 'warning'
    });
    if (discard) {
      const saved = savedEnvironment();
      setEnvironmentDraft(saved ? clone(saved) : null);
    }
    return discard;
  }

  async function changeMode(next: Mode) {
    if (next === mode()) return;
    if (mode() === 'environments' && !await canDiscardEnvironmentChanges()) return;
    setMode(next);
  }

  async function selectRequest(id: string, skipDiscard = false) {
    if (id === selectedRequestId()) return;
    const request = workspace()?.requests.find((item) => item.id === id);
    if (!request || (!skipDiscard && !await canDiscardRequestChanges())) return;
    setMode('workspace');
    setSelectedRequestId(id);
    setDraft(clone(request));
    setRequestValidationErrors({});
    setResponse(null);
  }

  async function saveRequest() {
    const current = draft();
    if (!current || !workspace() || requestBusy()) return;
    if (!validateCurrentRequest(current)) return;
    const submittedRevision = JSON.stringify(current);
    setSaving(true);
    try {
      const saved = await commands.saveRequest(clone(current));
      updateWorkspace((value) => ({
        ...value,
        requests: value.requests.some((item) => item.id === saved.id)
          ? value.requests.map((item) => item.id === saved.id ? saved : item)
          : [...value.requests, saved]
      }));
      if (selectedRequestId() === current.id && draft() && JSON.stringify(draft()) === submittedRevision) {
        setDraft(clone(saved));
        setSelectedRequestId(saved.id);
        setRequestValidationErrors({});
      }
      notify('Request saved');
    } catch (error) {
      notify(displayError(error), 'bad');
    } finally {
      setSaving(false);
    }
  }

  async function sendRequest() {
    const current = draft();
    const environmentId = selectedEnvironmentId();
    if (!current || !workspace() || requestBusy()) return;
    if (!validateCurrentRequest(current)) return;
    if (environmentDirty() && environmentDraft()?.id === environmentId) {
      setMode('environments');
      notify('Save or discard environment changes before sending', 'bad');
      return;
    }
    const submittedRevision = JSON.stringify(current);
    const submittedEnvironmentRevision = environmentDraft() ? JSON.stringify(environmentDraft()) : null;
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
      if (selectedRequestId() === current.id && draft() && JSON.stringify(draft()) === submittedRevision) {
        setDraft(clone(saved));
        setSelectedRequestId(saved.id);
        setRequestValidationErrors({});
      }
      const result = await commands.executeRequest(saved.id, environmentId);
      if (selectedRequestId() === saved.id) setResponse(result);
      const refreshed = await commands.getWorkspace();
      setWorkspace(refreshed);
      if (environmentDraft() && JSON.stringify(environmentDraft()) === submittedEnvironmentRevision) {
        const refreshedEnvironment = refreshed.environments.find((item) => item.id === environmentId);
        setEnvironmentDraft(refreshedEnvironment ? clone(refreshedEnvironment) : null);
      }
      notify(result.error ? 'Request completed with an error' : 'Response recorded', result.error ? 'bad' : 'good');
    } catch (error) {
      const message = displayError(error);
      if (selectedRequestId() === current.id) setResponse(emptyResponse(message));
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

  async function saveCollection(collection: Collection): Promise<boolean> {
    if (!workspace() || !collection.name.trim()) return false;
    try {
      const saved = await commands.saveCollection(clone(collection));
      updateWorkspace((value) => ({
        ...value,
        collections: value.collections.map((item) => item.id === saved.id ? saved : item)
      }));
      notify('Collection renamed');
      return true;
    } catch (error) {
      notify(displayError(error), 'bad');
      return false;
    }
  }

  async function deleteCollection(collection: Collection) {
    const deletingEditedRequest = Boolean(dirty() && draft()?.collectionId === collection.id);
    const message = deletingEditedRequest
      ? `Delete “${collection.name}”, every request inside it, and the unsaved changes to “${draft()!.name}”?`
      : `Delete “${collection.name}” and every request inside it?`;
    if (!workspace() || !await confirm(message, { title: 'Delete collection', kind: 'warning' })) return;
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
    if (!await canDiscardRequestChanges()) return;
    try {
      const saved = await commands.saveRequest(newRequest(collectionId));
      updateWorkspace((value) => ({ ...value, requests: [...value.requests, saved] }));
      await selectRequest(saved.id, true);
      notify('Request created');
    } catch (error) { notify(displayError(error), 'bad'); }
  }

  async function deleteRequest(request = draft()) {
    if (!workspace() || !request || requestBusy() || !await confirm(`Delete “${request.name}”?`, { title: 'Delete request', kind: 'warning' })) return;
    setDeleting(true);
    try {
      await commands.deleteRequest(request.id);
      const requests = workspace()!.requests.filter((item) => item.id !== request.id);
      updateWorkspace((value) => ({ ...value, requests }));
      if (selectedRequestId() === request.id) {
        const next = requests[0];
        setSelectedRequestId(next?.id ?? null);
        setDraft(next ? clone(next) : null);
        setRequestValidationErrors({});
        setResponse(null);
      }
      notify('Request deleted');
    } catch (error) { notify(displayError(error), 'bad'); }
    finally { setDeleting(false); }
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

  async function selectEnvironment(id: string) {
    const nextId = id || null;
    if (nextId === selectedEnvironmentId()) return;
    if (mode() === 'environments' && !await canDiscardEnvironmentChanges()) return;
    setSelectedEnvironmentId(nextId);
    const environment = workspace()?.environments.find((item) => item.id === nextId);
    if (mode() === 'environments') setEnvironmentDraft(environment ? clone(environment) : null);
  }

  async function createEnvironment() {
    if (!workspace()) return;
    if (!await canDiscardEnvironmentChanges()) return;
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
    if (!workspace() || !current || requestBusy() || hasEnvironmentValidationErrors()) return;
    const submittedRevision = JSON.stringify(current);
    setSaving(true);
    try {
      const saved = await commands.saveEnvironment(clone(current));
      updateWorkspace((value) => ({
        ...value,
        environments: value.environments.some((item) => item.id === saved.id)
          ? value.environments.map((item) => item.id === saved.id ? saved : item)
          : [...value.environments, saved]
      }));
      if (environmentDraft()?.id === current.id && JSON.stringify(environmentDraft()) === submittedRevision) {
        setEnvironmentDraft(clone(saved));
        setSelectedEnvironmentId(saved.id);
      }
      notify('Environment saved');
    } catch (error) { notify(displayError(error), 'bad'); }
    finally { setSaving(false); }
  }

  async function deleteEnvironment() {
    const current = environmentDraft();
    if (!workspace() || !current || requestBusy() || !await confirm(`Delete “${current.name}”?`, { title: 'Delete environment', kind: 'warning' })) return;
    setDeleting(true);
    try {
      await commands.deleteEnvironment(current.id);
      const environments = workspace()!.environments.filter((item) => item.id !== current.id);
      updateWorkspace((value) => ({ ...value, environments }));
      const next = environments[0];
      setSelectedEnvironmentId(next?.id ?? null);
      setEnvironmentDraft(next ? clone(next) : null);
      notify('Environment deleted');
    } catch (error) { notify(displayError(error), 'bad'); }
    finally { setDeleting(false); }
  }

  function openEnvironments() {
    if (mode() === 'environments') return;
    setMode('environments');
    const environment = workspace()?.environments.find((item) => item.id === selectedEnvironmentId()) ?? workspace()?.environments[0];
    setEnvironmentDraft(environment ? clone(environment) : null);
  }

  async function exportWorkspace() {
    if (transferring()) return;
    setTransferring(true);
    try {
      if (!await confirm('This export includes request URLs, headers, query parameters, bodies, scripts, environment values, and recorded response history. These may contain credentials or private data. Continue?', {
        title: 'Export sensitive workspace data',
        kind: 'warning'
      })) return;
      const path = await saveFile({ title: 'Export PostOwl workspace', defaultPath: 'postowl-workspace.json', filters: [{ name: 'PostOwl workspace', extensions: ['json'] }] });
      if (!path) return;
      await commands.exportWorkspace(path);
      notify(`Workspace exported to ${path}`);
    } catch (error) {
      notify(`Export failed: ${displayError(error)}`, 'bad');
    } finally {
      setTransferring(false);
    }
  }

  async function importWorkspace() {
    if (transferring() || !await canDiscardRequestChanges() || !await canDiscardEnvironmentChanges()) return;
    setTransferring(true);
    try {
      const selected = await openFile({ title: 'Import PostOwl workspace', multiple: false, directory: false, filters: [{ name: 'PostOwl workspace', extensions: ['json'] }] });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path || !await confirm('Importing replaces the current workspace. Continue?', { title: 'Import workspace', kind: 'warning' })) return;
      const imported = await commands.importWorkspace(path);
      setWorkspace(imported);
      setSelectedRequestId(imported.requests[0]?.id ?? null);
      setDraft(imported.requests[0] ? clone(imported.requests[0]) : null);
      setSelectedEnvironmentId(null);
      setEnvironmentDraft(null);
      setSelectedHistoryId(null);
      setResponse(null);
      setMode('workspace');
      notify('Workspace imported');
    } catch (error) {
      notify(`Import failed: ${displayError(error)}`, 'bad');
    } finally {
      setTransferring(false);
    }
  }

  function beginWorkbenchResize(event: PointerEvent & { currentTarget: HTMLButtonElement }) {
    const handle = event.currentTarget;
    const workbench = handle.parentElement;
    if (!workbench) return;
    const pointerId = event.pointerId;
    const update = (clientX: number) => {
      const bounds = workbench.getBoundingClientRect();
      const next = ((clientX - bounds.left) / bounds.width) * 100;
      setRequestPaneWidth(Math.min(70, Math.max(35, next)));
    };
    const move = (moveEvent: PointerEvent) => update(moveEvent.clientX);
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
      handle.removeEventListener('pointercancel', stop);
    };
    handle.setPointerCapture(pointerId);
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
    handle.addEventListener('pointercancel', stop);
    update(event.clientX);
  }

  function resizeWorkbenchFromKeyboard(event: KeyboardEvent) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', '0'].includes(event.key)) return;
    event.preventDefault();
    setRequestPaneWidth((current) => event.key === 'Home'
      ? 35
      : event.key === 'End'
        ? 70
        : event.key === '0'
          ? 55
          : Math.min(70, Math.max(35, current + (event.key === 'ArrowLeft' ? -2 : 2))));
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
        <button class="brand" type="button" onClick={() => void changeMode('workspace')} aria-label="Open workspace">
          <span class="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span><strong>PostOwl</strong><small>Request observatory</small></span>
        </button>
        <div class="topbar-actions">
          <label class="environment-select">
            <span>Environment</span>
            <select value={selectedEnvironmentId() ?? ''} onChange={(event) => void selectEnvironment(event.currentTarget.value)} disabled={requestBusy() || !workspace()?.environments.length}>
              <option value="">No environment</option>
              <For each={workspace()?.environments ?? []}>{(environment) => <option value={environment.id}>{environment.name}</option>}</For>
            </select>
          </label>
          <ActionButton onClick={openEnvironments}>Environments</ActionButton>
          <span class="topbar-rule" />
          <ActionButton onClick={() => void importWorkspace()} disabled={transferring()}>{transferring() ? 'Working…' : 'Import'}</ActionButton>
          <ActionButton onClick={() => void exportWorkspace()} disabled={!workspace() || transferring()}>Export</ActionButton>
        </div>
      </header>

      <Show when={!loading()} fallback={<main class="startup-state" role="status" aria-live="polite" aria-busy="true"><span class="owl-loader" aria-hidden="true" /><strong>Opening observatory</strong><span>Loading your local workspace…</span></main>}>
        <Show when={!loadError()} fallback={<main class="startup-state error-state" role="alert"><strong>Workspace unavailable</strong><span>{loadError()}</span><ActionButton tone="primary" onClick={() => void loadWorkspace()}>Try again</ActionButton></main>}>
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
                  onMode={(next) => void changeMode(next)}
                  onRequest={(id) => void selectRequest(id)}
                  onHistory={selectHistory}
                  onNewCollection={() => void createCollection()}
                  onNewRequest={(collectionId) => void createRequest(collectionId)}
                  onSaveCollection={saveCollection}
                  onDeleteCollection={(collection) => void deleteCollection(collection)}
                  onDeleteRequest={(request) => void deleteRequest(request)}
                  onClearHistory={() => void clearHistory()}
                />
              }>
                <aside class="sidebar environment-sidebar">
                  <div class="sidebar-section-head"><span>Environments</span><ActionButton onClick={() => void createEnvironment()} title="New environment" ariaLabel="New environment">+</ActionButton></div>
                  <div class="tree-scroll">
                    <For each={currentWorkspace().environments} fallback={<div class="sidebar-empty"><strong>No environments</strong><span>Create one to manage reusable request variables.</span><ActionButton tone="primary" onClick={() => void createEnvironment()}>Create environment</ActionButton></div>}>
                      {(environment) => <button class="environment-item" classList={{ active: environment.id === environmentDraft()?.id }} aria-current={environment.id === environmentDraft()?.id ? 'page' : undefined} onClick={() => void selectEnvironment(environment.id)}><span class="environment-signal" aria-hidden="true" /><span><strong>{environment.name}</strong><small>{environment.variables.filter((item) => item.enabled).length} active variables</small></span></button>}
                    </For>
                  </div>
                </aside>
              </Show>

              <main class="main-stage">
                <Show when={mode() === 'environments'} fallback={
                  <Show when={mode() === 'history'} fallback={
                    <Show when={draft()} fallback={<div class="main-empty"><span class="empty-glyph">HTTP</span><h1>Ready for a request</h1><p>Create a request in a collection or keep it unfiled.</p><ActionButton tone="primary" onClick={() => void createRequest(null)}>Create request</ActionButton></div>}>
                      <div class="workbench" style={`--request-pane:${requestPaneWidth()}%`}>
                        <RequestEditor
                          draft={draft()!}
                          onDraftChange={updateRequestDraft}
                          collections={currentWorkspace().collections}
                          dirty={dirty()}
                          busy={requestBusy()}
                          saving={saving()}
                          sending={sending()}
                          validationErrors={requestValidationErrors()}
                          onValidationController={(controller) => { requestValidationController = controller; }}
                          onSave={() => void saveRequest()}
                          onSend={() => void sendRequest()}
                          onDelete={() => void deleteRequest()}
                        />
                        <button
                          type="button"
                          class="signal-spine"
                          data-state={sending() ? 'pending' : response()?.error ? 'bad' : response() ? 'good' : 'idle'}
                          role="separator"
                          aria-label="Resize request and response panels"
                          aria-orientation="vertical"
                          aria-valuemin="35"
                          aria-valuemax="70"
                          aria-valuenow={Math.round(requestPaneWidth())}
                          aria-valuetext={`${Math.round(requestPaneWidth())}% request, ${100 - Math.round(requestPaneWidth())}% response`}
                          title="Drag to resize · Home/End for limits · 0 to reset"
                          onPointerDown={beginWorkbenchResize}
                          onKeyDown={resizeWorkbenchFromKeyboard}
                          onDblClick={() => setRequestPaneWidth(55)}
                        >
                          <span aria-hidden="true" />
                        </button>
                        <ResponsePanel response={response()} pending={sending()} />
                      </div>
                    </Show>
                  }>
                    <Show when={selectedHistory()} keyed fallback={<div class="main-empty"><span class="empty-glyph">REC</span><h1>Select a recorded request</h1><p>History preserves the exact response and telemetry from each transmission.</p></div>}>
                      {(entry) => <div class="history-stage"><header class="history-title"><span class={`method-tag method-${entry.method.toLowerCase()}`}>{entry.method}</span><div><span class="eyebrow">Recorded transmission</span><h1>{entry.requestName}</h1><p class="mono">{entry.url}</p><time dateTime={new Date(entry.executedAt).toISOString()}>{new Date(entry.executedAt).toLocaleString()}</time></div></header><ResponsePanel response={entry.response} /></div>}
                    </Show>
                  </Show>
                }>
                  <Show when={environmentDraft()} fallback={<div class="main-empty"><span class="empty-glyph">ENV</span><h1>Build a variable deck</h1><p>Keep host names and reusable values separate from requests.</p><ActionButton tone="primary" onClick={() => void createEnvironment()}>Create environment</ActionButton></div>}>
                    <EnvironmentEditor draft={environmentDraft()!} onDraftChange={setEnvironmentDraft} dirty={environmentDirty()} errors={environmentValidationErrors()} busy={requestBusy()} onSave={() => void saveEnvironment()} onDelete={() => void deleteEnvironment()} />
                  </Show>
                </Show>
              </main>
            </div>
          )}</Show>
        </Show>
      </Show>

      <Show when={toast()} keyed>{(currentToast) => <div class="toast" classList={{ bad: currentToast.tone === 'bad' }} role={currentToast.tone === 'bad' ? 'alert' : 'status'} aria-live={currentToast.tone === 'bad' ? 'assertive' : 'polite'}><span />{currentToast.text}</div>}</Show>
    </div>
  );
}
