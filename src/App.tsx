import { createMemo, createSignal, For, onCleanup, onMount, Show } from 'solid-js';
import { open as openFile, save as saveFile } from '@tauri-apps/plugin-dialog';
import { commands } from './lib/api';
import type { Collection, Environment, RequestDraft, ResponseData, Workspace } from './lib/types';
import { clone, displayError, newCollection, newEnvironment, newRequest } from './lib/utils';
import ActionButton from './lib/components/ActionButton';
import EnvironmentEditor, { type EnvironmentValidationErrors } from './lib/components/EnvironmentEditor';
import RequestEditor, { type RequestEditorValidationController } from './lib/components/RequestEditor';
import ResponsePanel from './lib/components/ResponsePanel';
import Sidebar from './lib/components/Sidebar';
import MethodTag from './lib/components/ui/MethodTag';
import { validateRequestDraft, type RequestValidationErrors } from './lib/validation';

type Mode = 'workspace' | 'history' | 'environments';
type Toast = { tone: 'good' | 'bad'; text: string };
type ConfirmationRequest = {
  title: string;
  message: string;
  action: string;
  danger: boolean;
  returnFocus: HTMLElement | null;
  resolve: (confirmed: boolean) => void;
};
const MAX_ENVIRONMENT_ROWS = 10_000;
const MAX_NAME_BYTES = 1_024;
const MAX_VALUE_BYTES = 1_048_576;
const MAX_ID_BYTES = 256;
const textEncoder = new TextEncoder();
const byteLength = (value: string) => textEncoder.encode(value).length;
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
  const [transferring, setTransferring] = createSignal(false);
  const [confirmation, setConfirmation] = createSignal<ConfirmationRequest | null>(null);
  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  let requestValidationController: RequestEditorValidationController | undefined;
  let confirmationActionLabel: HTMLSpanElement | undefined;

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

  function askConfirmation(
    message: string,
    options: { title: string; action: string; danger?: boolean }
  ): Promise<boolean> {
    const { promise, resolve } = Promise.withResolvers<boolean>();
    const activeElement = document.activeElement;
    setConfirmation({
      title: options.title,
      message,
      action: options.action,
      danger: options.danger ?? false,
      returnFocus: activeElement instanceof HTMLElement ? activeElement : null,
      resolve
    });
    queueMicrotask(() => confirmationActionLabel?.closest('button')?.focus());
    return promise;
  }

  function answerConfirmation(confirmed: boolean) {
    const current = confirmation();
    if (!current) return;
    setConfirmation(null);
    current.resolve(confirmed);
    queueMicrotask(() => current.returnFocus?.focus());
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
    return !dirty() || await askConfirmation('Discard the unsaved changes to this request?', {
      title: 'Unsaved request',
      action: 'Discard changes'
    });
  }

  async function canDiscardEnvironmentChanges() {
    if (!environmentDirty()) return true;
    const discard = await askConfirmation('Discard the unsaved changes to this environment?', {
      title: 'Unsaved environment',
      action: 'Discard changes'
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
    if (!workspace() || !await askConfirmation(message, {
      title: 'Delete collection',
      action: 'Delete collection',
      danger: true
    })) return;
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
    if (!workspace() || !request || requestBusy() || !await askConfirmation(`Delete “${request.name}”?`, {
      title: 'Delete request',
      action: 'Delete request',
      danger: true
    })) return;
    setDeleting(true);
    try {
      await commands.deleteRequest(request.id);
      const requests = workspace()!.requests.filter((item) => item.id !== request.id);
      updateWorkspace((value) => ({ ...value, requests }));
      if (selectedRequestId() === request.id) {
        setSelectedRequestId(null);
        setDraft(null);
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
    if (!workspace() || !await askConfirmation('Clear all recorded request history? This cannot be undone.', {
      title: 'Clear history',
      action: 'Clear history',
      danger: true
    })) return;
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
    if (!workspace() || !current || requestBusy() || !await askConfirmation(`Delete “${current.name}”?`, {
      title: 'Delete environment',
      action: 'Delete environment',
      danger: true
    })) return;
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
      if (!await askConfirmation('This export includes request URLs, headers, query parameters, bodies, scripts, environment values, and recorded response history. These may contain credentials or private data. Continue?', {
        title: 'Export sensitive workspace data',
        action: 'Export workspace'
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
      if (!path || !await askConfirmation('Importing replaces the current workspace. Continue?', {
        title: 'Import workspace',
        action: 'Replace workspace',
        danger: true
      })) return;
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


  onMount(() => {
    document.title = 'PostOwl — REST flight recorder';
    void loadWorkspace();
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && confirmation()) {
        event.preventDefault();
        answerConfirmation(false);
        return;
      }
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.key === 'Enter' && mode() === 'workspace' && draft()) { event.preventDefault(); void sendRequest(); }
      if (event.key.toLowerCase() === 's' && mode() === 'workspace' && draft()) { event.preventDefault(); void saveRequest(); }
    };
    window.addEventListener('keydown', handleKeydown);
    onCleanup(() => {
      window.removeEventListener('keydown', handleKeydown);
      clearTimeout(toastTimer);
      const currentConfirmation = confirmation();
      if (currentConfirmation) {
        setConfirmation(null);
        currentConfirmation.resolve(false);
      }
    });
  });

  return (
    <div class="app-shell grid h-full grid-rows-[4rem_minmax(0,1fr)] bg-canvas max-[54rem]:grid-rows-[auto_minmax(0,1fr)]">
      <header class="topbar relative z-5 flex items-center justify-between gap-6 border-b border-border-strong bg-raised px-6 shadow-[0_1px_0_rgba(255,255,255,0.8)] after:absolute after:-bottom-px after:left-0 after:h-0.5 after:w-70 after:bg-signal after:content-[''] max-[68rem]:after:w-62 max-[54rem]:min-h-16 max-[54rem]:py-2 max-[44rem]:gap-2 max-[44rem]:px-3 max-[36rem]:grid max-[36rem]:min-h-0 max-[36rem]:grid-cols-[auto_minmax(0,1fr)] max-[36rem]:gap-2 max-[36rem]:px-3 max-[36rem]:py-2 max-[36rem]:after:w-full">
        <button class="brand flex min-w-52 items-center gap-3 border-0 bg-transparent p-0 text-left focus-visible:relative focus-visible:z-2 focus-visible:outline-0 focus-visible:[box-shadow:var(--focus-ring)] max-[44rem]:min-w-auto max-[36rem]:min-w-control-default" type="button" onClick={() => void changeMode('workspace')} aria-label="Open workspace">
          <span class="brand-mark relative block size-[2.125rem] shrink-0 rounded-sm border border-naval bg-raised before:absolute before:top-1/2 before:right-1 before:left-1 before:h-px before:bg-signal-line before:content-['']" aria-hidden="true">
            <i class="absolute bottom-[0.4375rem] left-2 z-1 h-1.5 w-0.5 bg-signal" />
            <i class="absolute bottom-[0.4375rem] left-[0.9375rem] z-1 h-3.75 w-0.5 bg-coral" />
            <i class="absolute bottom-[0.4375rem] left-[1.375rem] z-1 h-2.5 w-0.5 bg-signal" />
          </span>
          <span>
            <strong class="block text-base tracking-[-0.01em] max-[44rem]:hidden">PostOwl</strong>
            <small class="mt-0.5 block font-data text-[0.6875rem] leading-none font-[650] tracking-[0.06em] text-ink-muted max-[54rem]:hidden">Request observatory</small>
          </span>
        </button>
        <div class="topbar-actions flex min-w-0 items-center justify-end gap-2 max-[68rem]:[&_.action]:px-2 max-[44rem]:gap-1 max-[44rem]:[&_.action]:px-2 max-[44rem]:[&_.action]:text-xs max-[36rem]:grid max-[36rem]:w-full max-[36rem]:grid-cols-[minmax(0,1fr)_auto_auto] max-[36rem]:gap-1 max-[36rem]:[&_.action]:min-w-0 [&_.topbar-rule~.action]:border-transparent [&_.topbar-rule~.action]:bg-transparent [&_.topbar-rule~.action]:text-ink-muted">
          <label class="environment-select flex items-center gap-2 text-xs font-semibold text-ink-muted max-[36rem]:col-span-full max-[36rem]:min-w-0">
            <span class="max-[54rem]:hidden">Environment</span>
            <select class="min-h-control-default w-42 rounded-sm border border-hairline bg-raised px-2 py-1 text-graphite hover:border-signal-line focus-visible:relative focus-visible:z-2 focus-visible:outline-0 focus-visible:[box-shadow:var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-48 max-[44rem]:w-28 max-[36rem]:w-full max-[36rem]:min-w-0" value={selectedEnvironmentId() ?? ''} onChange={(event) => void selectEnvironment(event.currentTarget.value)} disabled={requestBusy() || !workspace()?.environments.length}>
              <option value="">No environment</option>
              <For each={workspace()?.environments ?? []}>{(environment) => <option value={environment.id}>{environment.name}</option>}</For>
            </select>
          </label>
          <ActionButton onClick={openEnvironments}>Environments</ActionButton>
          <span class="topbar-rule mx-1 h-7 w-px bg-hairline max-[44rem]:hidden" />
          <ActionButton onClick={() => void importWorkspace()} disabled={transferring()}>{transferring() ? 'Working…' : 'Import'}</ActionButton>
          <ActionButton onClick={() => void exportWorkspace()} disabled={!workspace() || transferring()}>Export</ActionButton>
        </div>
      </header>

      <Show when={!loading()} fallback={<main class="startup-state grid h-full place-content-center justify-items-center gap-3 p-8 text-center text-ink-muted max-[36rem]:p-4" role="status" aria-live="polite" aria-busy="true"><span class="owl-loader size-10 animate-spin rounded-full border-2 border-hairline border-t-signal motion-reduce:animate-none" aria-hidden="true" /><strong>Opening observatory</strong><span class="m-0 max-w-md leading-[1.6]">Loading your local workspace…</span></main>}>
        <Show when={!loadError()} fallback={<main class="startup-state error-state grid h-full place-content-center justify-items-center gap-3 p-8 text-center text-ink-muted max-[36rem]:p-4" role="alert"><strong class="text-coral-ink">Workspace unavailable</strong><span class="m-0 max-w-md leading-[1.6]">{loadError()}</span><ActionButton tone="primary" onClick={() => void loadWorkspace()}>Try again</ActionButton></main>}>
          <Show when={workspace()}>{(currentWorkspace) => (
            <div class="workspace-shell grid min-h-0 grid-cols-[17.5rem_minmax(0,1fr)] max-[68rem]:grid-cols-[15.5rem_minmax(0,1fr)] max-[44rem]:grid-cols-[11.5rem_minmax(0,1fr)] max-[36rem]:grid-cols-[minmax(0,1fr)] max-[36rem]:grid-rows-[clamp(calc(2*var(--spacing-control-default)+1rem),34%,calc(3*var(--spacing-control-default)+0.75rem))_minmax(0,1fr)]">
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
                <aside class="sidebar environment-sidebar grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] border-r border-border-strong bg-panel [&_button.environment-item]:focus-visible:relative [&_button.environment-item]:focus-visible:z-2 [&_button.environment-item]:focus-visible:outline-0 [&_button.environment-item]:focus-visible:[box-shadow:var(--focus-ring)] max-[36rem]:border-r-0 max-[36rem]:border-b">
                  <div class="sidebar-section-head flex min-h-11 items-center justify-between border-b border-hairline px-3 py-2 font-data text-[0.6875rem] leading-none font-bold tracking-[0.07em] text-ink-muted before:mr-2 before:h-0.5 before:w-4 before:bg-signal before:content-[''] max-[36rem]:min-h-control-default max-[36rem]:py-1 [&>.action]:min-h-7 [&>.action]:px-2"><span class="mr-auto">Environments</span><ActionButton onClick={() => void createEnvironment()} title="New environment" ariaLabel="New environment">+</ActionButton></div>
                  <div class="tree-scroll min-h-0 overflow-auto">
                    <For each={currentWorkspace().environments} fallback={<div class="sidebar-empty flex flex-col items-start gap-2 px-4 py-6 text-[0.8125rem] leading-[1.5] text-ink-muted"><strong class="text-graphite">No environments</strong><span>Create one to manage reusable request variables.</span><ActionButton tone="primary" onClick={() => void createEnvironment()}>Create environment</ActionButton></div>}>
                      {(environment) => <button class="environment-item flex min-h-14 w-full items-center gap-3 border-0 border-b border-hairline bg-transparent p-3 text-left text-ink-muted hover:bg-naval-soft [&.active]:bg-signal-soft [&.active]:shadow-[inset_3px_0_var(--color-signal)] max-[36rem]:min-h-control-default max-[36rem]:py-2" classList={{ active: environment.id === environmentDraft()?.id }} aria-current={environment.id === environmentDraft()?.id ? 'page' : undefined} onClick={() => void selectEnvironment(environment.id)}><span class="environment-signal size-2 shrink-0 rounded-full border border-signal shadow-[0_0_0_0.1875rem_var(--color-signal-soft)]" aria-hidden="true" /><span class="min-w-0"><strong class="block truncate">{environment.name}</strong><small class="mt-1 block truncate font-data text-[0.6875rem] leading-[1.2] text-ink-muted">{environment.variables.filter((item) => item.enabled).length} active variables</small></span></button>}
                    </For>
                  </div>
                </aside>
              </Show>

              <main class="main-stage @container min-h-0 min-w-0 overflow-hidden bg-canvas">
                <Show when={mode() === 'environments'} fallback={
                  <Show when={mode() === 'history'} fallback={
                    <Show
                      when={draft()}
                      fallback={
                        <div class="main-empty grid h-full place-content-center justify-items-center gap-3 p-8 text-center text-ink-muted max-[36rem]:p-4">
                          <span class="empty-glyph relative grid h-12 min-w-16 place-items-center rounded-sm border border-signal-line bg-raised font-data text-[0.6875rem] leading-none font-[750] tracking-[0.08em] text-naval after:absolute after:-right-4 after:h-px after:w-4 after:bg-signal after:content-['']">HTTP</span>
                          <h1 class="my-1 mb-2 text-2xl font-[750] tracking-[-0.02em] text-graphite">Ready for a request</h1>
                          <p class="m-0 max-w-md leading-[1.6]">Create a request in a collection or keep it unfiled.</p>
                          <ActionButton tone="primary" onClick={() => void createRequest(null)}>Create request</ActionButton>
                        </div>
                      }
                    >
                      <div class="workbench grid h-full min-h-0 grid-cols-1 grid-rows-[minmax(22rem,1fr)_minmax(19rem,0.9fr)] overflow-auto max-[36rem]:w-full max-[36rem]:grid-rows-[minmax(19rem,1fr)_minmax(17rem,0.9fr)] [&>.request-editor]:border-b [&>.request-editor]:border-border-strong">
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
                        <ResponsePanel response={response()} pending={sending()} />
                      </div>
                    </Show>
                  }>
                    <Show
                      when={selectedHistory()}
                      keyed
                      fallback={
                        <div class="main-empty grid h-full place-content-center justify-items-center gap-3 p-8 text-center text-ink-muted max-[36rem]:p-4">
                          <span class="empty-glyph relative grid h-12 min-w-16 place-items-center rounded-sm border border-signal-line bg-raised font-data text-[0.6875rem] leading-none font-[750] tracking-[0.08em] text-naval after:absolute after:-right-4 after:h-px after:w-4 after:bg-signal after:content-['']">REC</span>
                          <h1 class="my-1 mb-2 text-2xl font-[750] tracking-[-0.02em] text-graphite">Select a recorded request</h1>
                          <p class="m-0 max-w-md leading-[1.6]">History preserves the exact response and telemetry from each transmission.</p>
                        </div>
                      }
                    >
                      {(entry) => (
                        <div class="history-stage grid h-full grid-rows-[auto_minmax(0,1fr)]">
                          <header class="history-title flex min-h-20 items-center gap-4 border-b border-border-strong bg-raised p-4 max-[36rem]:min-h-0 max-[36rem]:flex-wrap max-[36rem]:items-start max-[36rem]:p-3">
                            <MethodTag method={entry.method} />
                            <div class="min-w-0">
                              <span class="eyebrow mb-1 flex items-center gap-1.5 font-data text-[0.6875rem] leading-none font-bold tracking-[0.07em] text-ink-muted">Recorded transmission</span>
                              <h1 class="my-1 mb-2 text-lg font-[750] tracking-[-0.02em] text-graphite">{entry.requestName}</h1>
                              <p class="mono m-0 max-w-3xl truncate text-xs text-ink-muted max-[36rem]:whitespace-normal max-[36rem]:[overflow-wrap:anywhere]">{entry.url}</p>
                              <time class="mt-1 block font-data text-[0.6875rem] leading-[1.2] text-ink-muted" dateTime={new Date(entry.executedAt).toISOString()}>{new Date(entry.executedAt).toLocaleString()}</time>
                            </div>
                          </header>
                          <ResponsePanel response={entry.response} />
                        </div>
                      )}
                    </Show>
                  </Show>
                }>
                  <Show
                    when={environmentDraft()}
                    fallback={
                      <div class="main-empty grid h-full place-content-center justify-items-center gap-3 p-8 text-center text-ink-muted max-[36rem]:p-4">
                        <span class="empty-glyph relative grid h-12 min-w-16 place-items-center rounded-sm border border-signal-line bg-raised font-data text-[0.6875rem] leading-none font-[750] tracking-[0.08em] text-naval after:absolute after:-right-4 after:h-px after:w-4 after:bg-signal after:content-['']">ENV</span>
                        <h1 class="my-1 mb-2 text-2xl font-[750] tracking-[-0.02em] text-graphite">Build a variable deck</h1>
                        <p class="m-0 max-w-md leading-[1.6]">Keep host names and reusable values separate from requests.</p>
                        <ActionButton tone="primary" onClick={() => void createEnvironment()}>Create environment</ActionButton>
                      </div>
                    }
                  >
                    <EnvironmentEditor draft={environmentDraft()!} onDraftChange={setEnvironmentDraft} dirty={environmentDirty()} errors={environmentValidationErrors()} busy={requestBusy()} onSave={() => void saveEnvironment()} onDelete={() => void deleteEnvironment()} />
                  </Show>
                </Show>
              </main>
            </div>
          )}</Show>
        </Show>
      </Show>

      <Show when={toast()} keyed>{(currentToast) => <div class="toast fixed right-4 bottom-4 z-20 flex max-w-md items-center gap-2 rounded-sm border border-hairline bg-raised px-4 py-3 text-graphite shadow-float animate-[toast-in_180ms_var(--ease-out)] motion-reduce:animate-none max-[36rem]:right-2 max-[36rem]:bottom-2 max-[36rem]:left-2 max-[36rem]:max-w-none" classList={{ bad: currentToast.tone === 'bad' }} role={currentToast.tone === 'bad' ? 'alert' : 'status'} aria-live={currentToast.tone === 'bad' ? 'assertive' : 'polite'}><span class="size-[0.4375rem] rounded-full" classList={{ 'bg-signal': currentToast.tone === 'good', 'bg-coral': currentToast.tone === 'bad' }} />{currentToast.text}</div>}</Show>
      <Show when={confirmation()} keyed>
        {(currentConfirmation) => (
          <div
            class="fixed inset-0 z-30 grid place-items-center bg-[rgb(20_42_58/0.46)] p-4 backdrop-blur-[1px]"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) answerConfirmation(false);
            }}
          >
            <section
              class="relative w-full max-w-md overflow-hidden rounded-sm border border-border-strong bg-raised shadow-float before:absolute before:inset-x-0 before:top-0 before:h-0.75 before:bg-signal before:content-['']"
              classList={{ 'before:bg-coral': currentConfirmation.danger }}
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="confirmation-title"
              aria-describedby="confirmation-message"
            >
              <div class="border-b border-hairline px-5 pt-6 pb-4">
                <span
                  class="mb-2 block font-data text-[0.6875rem] leading-none font-bold tracking-[0.07em] text-signal-ink uppercase"
                  classList={{ 'text-coral-ink': currentConfirmation.danger }}
                >
                  {currentConfirmation.danger ? 'Destructive action' : 'Confirmation required'}
                </span>
                <h2 id="confirmation-title" class="m-0 text-lg font-[750] text-graphite">{currentConfirmation.title}</h2>
              </div>
              <p id="confirmation-message" class="m-0 px-5 py-5 text-[0.875rem] leading-6 text-naval">{currentConfirmation.message}</p>
              <div class="flex justify-end gap-2 border-t border-hairline bg-canvas px-5 py-4">
                <ActionButton onClick={() => answerConfirmation(false)}>Cancel</ActionButton>
                <ActionButton
                  tone="primary"
                  onClick={() => answerConfirmation(true)}
                  ariaLabel={currentConfirmation.action}
                >
                  <span ref={confirmationActionLabel}>{currentConfirmation.action}</span>
                </ActionButton>
              </div>
            </section>
          </div>
        )}
      </Show>

    </div>
  );
}
