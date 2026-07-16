import { For, Show, createMemo, createSignal } from 'solid-js';
import type { Collection, HistoryEntry, RequestDraft } from '../types';
import { formatTime } from '../utils';
import MethodTag from './ui/MethodTag';

type SidebarMode = 'workspace' | 'history' | 'environments';

interface RenameDraft {
  sourceName: string;
  value: string;
  submittedValue?: string;
}

interface RenameError {
  sourceName: string;
  message: string;
}

const EMPTY_REQUESTS: RequestDraft[] = [];

const FOCUS_CLASSES =
  'focus-visible:z-[2] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-raised';
const ICON_BUTTON_CLASSES =
  `relative grid size-control-compact shrink-0 place-items-center rounded-sm border border-hairline bg-raised p-0 text-ink-muted transition-[border-color,background-color,color,box-shadow,transform] duration-150 ease-out after:absolute after:-inset-1 after:content-[''] hover:border-signal-line hover:bg-signal-soft hover:text-graphite active:translate-y-px ${FOCUS_CLASSES}`;
const DANGER_ICON_CLASSES =
  'hover:border-coral-line hover:bg-coral-soft hover:text-coral-ink';

const collectionDomId = (kind: 'requests' | 'name' | 'error', collectionId: string) =>
  `collection-${kind}-${encodeURIComponent(collectionId)}`;
type SelectableSidebarMode = Exclude<SidebarMode, 'environments'>;

export interface SidebarProps {
  collections: Collection[];
  requests: RequestDraft[];
  history: HistoryEntry[];
  mode: SidebarMode;
  selectedRequestId: string | null;
  selectedHistoryId: string | null;
  onMode: (mode: SelectableSidebarMode) => void;
  onRequest: (id: string) => void;
  onHistory: (id: string) => void;
  onNewCollection: () => void;
  onNewRequest: (collectionId: string | null) => void;
  onSaveCollection: (collection: Collection) => Promise<boolean>;
  onDeleteCollection: (collection: Collection) => void;
  onDeleteRequest: (request: RequestDraft) => void;
  onClearHistory: () => void;
}

export default function Sidebar(props: SidebarProps) {
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({});
  const [renameDrafts, setRenameDrafts] = createSignal<Record<string, RenameDraft>>({});
  const [renameErrors, setRenameErrors] = createSignal<Record<string, RenameError>>({});

  const groupedRequests = createMemo(() => {
    const byCollection = new Map<string, RequestDraft[]>();
    const unfiled: RequestDraft[] = [];

    for (const request of props.requests) {
      if (request.collectionId === null) {
        unfiled.push(request);
        continue;
      }

      const requests = byCollection.get(request.collectionId);
      if (requests) requests.push(request);
      else byCollection.set(request.collectionId, [request]);
    }

    return { byCollection, unfiled };
  });

  const isExpanded = (collectionId: string) => expanded()[collectionId] !== false;
  const requestsInCollection = (collectionId: string) =>
    groupedRequests().byCollection.get(collectionId) ?? EMPTY_REQUESTS;
  const renameDraft = (collection: Collection) => {
    const draft = renameDrafts()[collection.id];
    return draft?.sourceName === collection.name ? draft : undefined;
  };
  const renameValue = (collection: Collection) => renameDraft(collection)?.value ?? collection.name;
  const renameError = (collection: Collection) => {
    const error = renameErrors()[collection.id];
    return error?.sourceName === collection.name ? error.message : undefined;
  };
  const beginRename = (collection: Collection) => {
    setRenameDrafts((current) => ({
      ...current,
      [collection.id]: { sourceName: collection.name, value: collection.name }
    }));
    setRenameErrors((current) => {
      if (!(collection.id in current)) return current;
      const next = { ...current };
      delete next[collection.id];
      return next;
    });
  };
  const updateRename = (collection: Collection, value: string) => {
    setRenameDrafts((current) => ({
      ...current,
      [collection.id]: { sourceName: collection.name, value }
    }));
    setRenameErrors((current) => {
      if (!(collection.id in current)) return current;
      const next = { ...current };
      delete next[collection.id];
      return next;
    });
  };
  const revertRename = (collection: Collection) => {
    setRenameDrafts((current) => ({
      ...current,
      [collection.id]: { sourceName: collection.name, value: collection.name }
    }));
    setRenameErrors((current) => {
      if (!(collection.id in current)) return current;
      const next = { ...current };
      delete next[collection.id];
      return next;
    });
  };
  const commitRename = async (collection: Collection) => {
    const draft = renameDraft(collection);
    const nextName = (draft?.value ?? collection.name).trim();

    if (!nextName) {
      setRenameDrafts((current) => ({
        ...current,
        [collection.id]: { sourceName: collection.name, value: collection.name }
      }));
      setRenameErrors((current) => ({
        ...current,
        [collection.id]: {
          sourceName: collection.name,
          message: 'Collection name cannot be blank.'
        }
      }));
      return;
    }

    setRenameErrors((current) => {
      if (!(collection.id in current)) return current;
      const next = { ...current };
      delete next[collection.id];
      return next;
    });
    setRenameDrafts((current) => ({
      ...current,
      [collection.id]: {
        sourceName: collection.name,
        value: nextName,
        submittedValue: nextName
      }
    }));

    if (nextName === collection.name || draft?.submittedValue === nextName) return;
    if (await props.onSaveCollection({ ...collection, name: nextName })) return;
    setRenameDrafts((current) => ({
      ...current,
      [collection.id]: { sourceName: collection.name, value: collection.name }
    }));
  };

  return (
    <aside class="sidebar grid min-h-0 min-w-0 grid-rows-[auto_auto_minmax(0,1fr)] border-r border-border-strong bg-panel max-[36rem]:border-r-0 max-[36rem]:border-b">
      <nav
        class="sidebar-tabs grid grid-cols-2 gap-1 border-b border-hairline bg-raised p-2 max-[36rem]:p-1"
        aria-label="Workspace navigation"
      >
        <button
          type="button"
          class={`min-h-control-default rounded-sm border-0 bg-transparent p-2 text-[0.8125rem] font-semibold text-ink-muted hover:bg-naval-soft hover:text-naval aria-[current=page]:bg-naval aria-[current=page]:text-raised ${FOCUS_CLASSES}`}
          aria-current={props.mode === 'workspace' ? 'page' : undefined}
          classList={{ active: props.mode === 'workspace' }}
          onClick={() => props.onMode('workspace')}
        >
          Workspace
        </button>
        <button
          type="button"
          class={`min-h-control-default rounded-sm border-0 bg-transparent p-2 text-[0.8125rem] font-semibold text-ink-muted hover:bg-naval-soft hover:text-naval aria-[current=page]:bg-naval aria-[current=page]:text-raised ${FOCUS_CLASSES}`}
          aria-current={props.mode === 'history' ? 'page' : undefined}
          classList={{ active: props.mode === 'history' }}
          onClick={() => props.onMode('history')}
        >
          History
        </button>
      </nav>

      <Show
        when={props.mode === 'history'}
        fallback={
          <>
            <div class="sidebar-section-head flex min-h-11 items-center justify-between border-b border-hairline px-3 py-2 font-data text-[0.6875rem] leading-none font-bold tracking-[0.07em] text-ink-muted before:mr-2 before:h-0.5 before:w-4 before:bg-signal before:content-[''] max-[36rem]:min-h-control-default max-[36rem]:py-1">
              <span class="mr-auto">COLLECTIONS</span>
              <button
                type="button"
                class={`action relative grid size-control-compact place-items-center rounded-sm border border-hairline bg-raised p-0 text-[0.8125rem] font-semibold text-naval transition-[border-color,background-color,color,box-shadow,transform] duration-150 ease-out hover:border-signal-line hover:bg-signal-soft hover:text-graphite active:translate-y-px ${FOCUS_CLASSES}`}
                onClick={props.onNewCollection}
                title="New collection"
                aria-label="New collection"
              >
                +
              </button>
            </div>
            <div class="tree-scroll min-h-0 overflow-auto">
              <For each={props.collections}>
                {(collection) => {
                  const requestPanelId = collectionDomId('requests', collection.id);
                  const nameInputId = collectionDomId('name', collection.id);
                  const renameErrorId = collectionDomId('error', collection.id);

                  return (
                    <section class="collection-node border-b border-hairline">
                      <div class="collection-row flex min-h-10.5 items-center gap-1 px-2 py-1 max-[36rem]:min-h-control-default">
                        <button
                          class={`disclosure group relative grid size-control-compact shrink-0 place-items-center border-0 bg-transparent p-0 text-ink-muted after:absolute after:-inset-1 after:content-[''] ${FOCUS_CLASSES}`}
                          type="button"
                          classList={{ collapsed: !isExpanded(collection.id) }}
                          aria-label={`${isExpanded(collection.id) ? 'Collapse' : 'Expand'} ${collection.name}`}
                          aria-expanded={isExpanded(collection.id)}
                          aria-controls={requestPanelId}
                          onClick={() =>
                            setExpanded((current) => ({
                              ...current,
                              [collection.id]: !isExpanded(collection.id)
                            }))
                          }
                        >
                          <span
                            class="transition-transform duration-150 ease-out"
                            classList={{ '-rotate-90': !isExpanded(collection.id) }}
                            aria-hidden="true"
                          >
                            ⌄
                          </span>
                        </button>
                        <input
                          class={`min-h-control-compact min-w-0 flex-1 rounded-sm border border-transparent bg-transparent p-1 font-bold hover:border-hairline aria-[invalid=true]:border-coral-line ${FOCUS_CLASSES}`}
                          id={nameInputId}
                          value={renameValue(collection)}
                          aria-label={`Collection name for ${collection.name}`}
                          aria-invalid={renameError(collection) ? 'true' : undefined}
                          aria-describedby={renameError(collection) ? renameErrorId : undefined}
                          onFocus={() => beginRename(collection)}
                          onInput={(event) => updateRename(collection, event.currentTarget.value)}
                          onBlur={() => commitRename(collection)}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') {
                              event.preventDefault();
                              commitRename(collection);
                              event.currentTarget.select();
                            } else if (event.key === 'Escape') {
                              event.preventDefault();
                              revertRename(collection);
                              event.currentTarget.select();
                            }
                          }}
                        />
                        <span
                          class="collection-count grid h-5.5 min-w-5.5 place-items-center rounded-full border border-hairline font-data text-[0.625rem] leading-none font-bold text-ink-muted"
                          aria-label={`${requestsInCollection(collection.id).length} requests`}
                        >
                          {requestsInCollection(collection.id).length}
                        </span>
                        <button
                          class={`icon-button ${ICON_BUTTON_CLASSES}`}
                          title="New request"
                          aria-label={`New request in ${collection.name}`}
                          onClick={() => props.onNewRequest(collection.id)}
                        >
                          +
                        </button>
                        <button
                          class={`icon-button danger-icon ${ICON_BUTTON_CLASSES} ${DANGER_ICON_CLASSES}`}
                          title="Delete collection"
                          aria-label={`Delete collection ${collection.name}`}
                          onClick={() => props.onDeleteCollection(collection)}
                        >
                          ×
                        </button>
                      </div>
                      <Show when={renameError(collection)}>
                        {(message) => (
                          <span
                            id={renameErrorId}
                            class="collection-rename-error mx-2 mb-2 block pl-11 text-[0.6875rem] leading-[1.4] text-coral-ink"
                            role="alert"
                          >
                            {message()}
                          </span>
                        )}
                      </Show>
                      <div
                        id={requestPanelId}
                        class="request-tree pb-2 pr-2 pl-5"
                        hidden={!isExpanded(collection.id)}
                      >
                        <For
                          each={requestsInCollection(collection.id)}
                          fallback={
                            <button
                              class={`add-first relative border-0 bg-transparent p-2 text-left text-xs text-ink-muted after:absolute after:-inset-1 after:content-[''] hover:text-signal-ink ${FOCUS_CLASSES}`}
                              aria-label={`Add first request to ${collection.name}`}
                              onClick={() => props.onNewRequest(collection.id)}
                            >
                              + Add first request
                            </button>
                          }
                        >
                          {(request) => (
                            <div
                              class="tree-request group relative flex min-h-9.5 min-w-0 rounded-sm hover:bg-naval-soft"
                              classList={{
                                active: request.id === props.selectedRequestId,
                                'bg-signal-soft': request.id === props.selectedRequestId,
                                '[box-shadow:inset_3px_0_var(--color-signal)]':
                                  request.id === props.selectedRequestId
                              }}
                            >
                              <button
                                aria-label={`${request.name} in ${collection.name}`}
                                aria-current={request.id === props.selectedRequestId ? 'page' : undefined}
                                class={`flex min-w-0 flex-1 items-center gap-2 border-0 bg-transparent px-2 py-2 text-left text-ink-muted group-[.active]:font-bold group-[.active]:text-graphite ${FOCUS_CLASSES}`}
                                onClick={() => props.onRequest(request.id)}
                              >
                                <MethodTag method={request.method} tree />
                                <span class="request-name truncate">{request.name}</span>
                              </button>
                              <button
                                class={`icon-button danger-icon opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 ${ICON_BUTTON_CLASSES} ${DANGER_ICON_CLASSES}`}
                                aria-label={`Delete ${request.name} from ${collection.name}`}
                                title="Delete request"
                                onClick={() => props.onDeleteRequest(request)}
                              >
                                ×
                              </button>
                            </div>
                          )}
                        </For>
                      </div>
                    </section>
                  );
                }}
              </For>

              <section class="collection-node unfiled border-b border-hairline bg-canvas">
                <div class="collection-row flex min-h-10.5 items-center gap-1 px-2 py-1 max-[36rem]:min-h-control-default">
                  <span class="disclosure grid size-control-compact shrink-0 place-items-center text-ink-muted" aria-hidden="true">—</span>
                  <span class="collection-label flex-1 font-bold text-naval">Unfiled</span>
                  <span
                    class="collection-count grid h-5.5 min-w-5.5 place-items-center rounded-full border border-hairline font-data text-[0.625rem] leading-none font-bold text-ink-muted"
                    aria-label={`${groupedRequests().unfiled.length} unfiled requests`}
                  >
                    {groupedRequests().unfiled.length}
                  </span>
                  <button
                    class={`icon-button ${ICON_BUTTON_CLASSES}`}
                    title="New unfiled request"
                    aria-label="New unfiled request"
                    onClick={() => props.onNewRequest(null)}
                  >
                    +
                  </button>
                </div>
                <div class="request-tree pb-2 pr-2 pl-5">
                  <For
                    each={groupedRequests().unfiled}
                    fallback={
                      <button
                        class={`add-first relative border-0 bg-transparent p-2 text-left text-xs text-ink-muted after:absolute after:-inset-1 after:content-[''] hover:text-signal-ink ${FOCUS_CLASSES}`}
                        aria-label="Create first unfiled request"
                        onClick={() => props.onNewRequest(null)}
                      >
                        + New request
                      </button>
                    }
                  >
                    {(request) => (
                      <div
                        class="tree-request group relative flex min-h-9.5 min-w-0 rounded-sm hover:bg-naval-soft"
                        classList={{
                          active: request.id === props.selectedRequestId,
                          'bg-signal-soft': request.id === props.selectedRequestId,
                          '[box-shadow:inset_3px_0_var(--color-signal)]':
                            request.id === props.selectedRequestId
                        }}
                      >
                        <button
                          aria-label={`${request.name}, unfiled`}
                          aria-current={request.id === props.selectedRequestId ? 'page' : undefined}
                          class={`flex min-w-0 flex-1 items-center gap-2 border-0 bg-transparent px-2 py-2 text-left text-ink-muted group-[.active]:font-bold group-[.active]:text-graphite ${FOCUS_CLASSES}`}
                          onClick={() => props.onRequest(request.id)}
                        >
                          <MethodTag method={request.method} tree />
                          <span class="request-name truncate">{request.name}</span>
                        </button>
                        <button
                          class={`icon-button danger-icon opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 ${ICON_BUTTON_CLASSES} ${DANGER_ICON_CLASSES}`}
                          aria-label={`Delete unfiled request ${request.name}`}
                          title="Delete request"
                          onClick={() => props.onDeleteRequest(request)}
                        >
                          ×
                        </button>
                      </div>
                    )}
                  </For>
                </div>
              </section>
            </div>
          </>
        }
      >
        <div class="sidebar-section-head flex min-h-11 items-center justify-between border-b border-hairline px-3 py-2 font-data text-[0.6875rem] leading-none font-bold tracking-[0.07em] text-ink-muted before:mr-2 before:h-0.5 before:w-4 before:bg-signal before:content-[''] max-[36rem]:min-h-control-default max-[36rem]:py-1">
          <span class="mr-auto">{props.history.length} RECORDS</span>
          <Show when={props.history.length > 0}>
            <button
              class={`relative border-0 bg-transparent p-1 text-xs text-coral-ink after:absolute after:-inset-1 after:content-[''] hover:text-coral ${FOCUS_CLASSES}`}
              onClick={props.onClearHistory}
            >
              Clear
            </button>
          </Show>
        </div>
        <div class="tree-scroll min-h-0 overflow-auto">
          <Show
            when={props.history.length > 0}
            fallback={
              <div class="sidebar-empty flex flex-col items-start gap-2 px-4 py-6 text-[0.8125rem] leading-normal text-ink-muted">
                <strong class="text-graphite">No recorded flights</strong>
                <span>Completed requests appear here and persist across restarts.</span>
              </div>
            }
          >
            <For each={props.history}>
              {(entry) => (
                <button
                  class={`history-item flex min-h-14 w-full items-center gap-3 border-0 border-b border-hairline bg-transparent p-3 text-left text-ink-muted hover:bg-naval-soft aria-[current=page]:bg-signal-soft aria-[current=page]:[box-shadow:inset_3px_0_var(--color-signal)] max-[36rem]:min-h-control-default max-[36rem]:py-2 ${FOCUS_CLASSES}`}
                  classList={{ active: entry.id === props.selectedHistoryId }}
                  aria-current={entry.id === props.selectedHistoryId ? 'page' : undefined}
                  onClick={() => props.onHistory(entry.id)}
                >
                  <MethodTag method={entry.method} />
                  <span class="history-copy min-w-0">
                    <strong class="block truncate">{entry.requestName}</strong>
                    <small class="mt-1 block truncate font-data text-[0.6875rem] leading-[1.2] text-ink-muted">
                      {entry.response.status ?? 'ERR'} · {formatTime(entry.executedAt)}
                    </small>
                  </span>
                </button>
              )}
            </For>
          </Show>
        </div>
      </Show>
    </aside>
  );
}
