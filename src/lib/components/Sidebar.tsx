import { For, Show, createMemo, createSignal } from 'solid-js';
import type { Collection, HistoryEntry, RequestDraft } from '../types';
import { formatTime } from '../utils';
import ActionButton from './ActionButton';

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
    <aside class="sidebar">
      <nav class="sidebar-tabs" aria-label="Workspace navigation">
        <button
          type="button"
          aria-current={props.mode === 'workspace' ? 'page' : undefined}
          classList={{ active: props.mode === 'workspace' }}
          onClick={() => props.onMode('workspace')}
        >
          Workspace
        </button>
        <button
          type="button"
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
            <div class="sidebar-section-head">
              <span>COLLECTIONS</span>
              <ActionButton onClick={props.onNewCollection} title="New collection" ariaLabel="New collection">
                +
              </ActionButton>
            </div>
            <div class="tree-scroll">
              <For each={props.collections}>
                {(collection) => {
                  const requestPanelId = collectionDomId('requests', collection.id);
                  const nameInputId = collectionDomId('name', collection.id);
                  const renameErrorId = collectionDomId('error', collection.id);

                  return (
                    <section class="collection-node">
                      <div class="collection-row">
                        <button
                          class="disclosure"
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
                          <span aria-hidden="true">⌄</span>
                        </button>
                        <input
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
                          class="collection-count"
                          aria-label={`${requestsInCollection(collection.id).length} requests`}
                        >
                          {requestsInCollection(collection.id).length}
                        </span>
                        <button
                          class="icon-button"
                          title="New request"
                          aria-label={`New request in ${collection.name}`}
                          onClick={() => props.onNewRequest(collection.id)}
                        >
                          +
                        </button>
                        <button
                          class="icon-button danger-icon"
                          title="Delete collection"
                          aria-label={`Delete collection ${collection.name}`}
                          onClick={() => props.onDeleteCollection(collection)}
                        >
                          ×
                        </button>
                      </div>
                      <Show when={renameError(collection)}>
                        {(message) => (
                          <span id={renameErrorId} class="collection-rename-error" role="alert">
                            {message()}
                          </span>
                        )}
                      </Show>
                      <div id={requestPanelId} class="request-tree" hidden={!isExpanded(collection.id)}>
                        <For
                          each={requestsInCollection(collection.id)}
                          fallback={
                            <button
                              class="add-first"
                              aria-label={`Add first request to ${collection.name}`}
                              onClick={() => props.onNewRequest(collection.id)}
                            >
                              + Add first request
                            </button>
                          }
                        >
                          {(request) => (
                            <div
                              class="tree-request"
                              classList={{ active: request.id === props.selectedRequestId }}
                            >
                              <button
                                aria-label={`${request.name} in ${collection.name}`}
                                aria-current={request.id === props.selectedRequestId ? 'page' : undefined}
                                onClick={() => props.onRequest(request.id)}
                              >
                                <span class={`method-tag tree-method method-${request.method.toLowerCase()}`}>
                                  {request.method}
                                </span>
                                <span class="request-name">{request.name}</span>
                              </button>
                              <button
                                class="icon-button danger-icon"
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

              <section class="collection-node unfiled">
                <div class="collection-row">
                  <span class="disclosure" aria-hidden="true">—</span>
                  <span class="collection-label">Unfiled</span>
                  <span
                    class="collection-count"
                    aria-label={`${groupedRequests().unfiled.length} unfiled requests`}
                  >
                    {groupedRequests().unfiled.length}
                  </span>
                  <button
                    class="icon-button"
                    title="New unfiled request"
                    aria-label="New unfiled request"
                    onClick={() => props.onNewRequest(null)}
                  >
                    +
                  </button>
                </div>
                <div class="request-tree">
                  <For
                    each={groupedRequests().unfiled}
                    fallback={
                      <button
                        class="add-first"
                        aria-label="Create first unfiled request"
                        onClick={() => props.onNewRequest(null)}
                      >
                        + New request
                      </button>
                    }
                  >
                    {(request) => (
                      <div
                        class="tree-request"
                        classList={{ active: request.id === props.selectedRequestId }}
                      >
                        <button
                          aria-label={`${request.name}, unfiled`}
                          aria-current={request.id === props.selectedRequestId ? 'page' : undefined}
                          onClick={() => props.onRequest(request.id)}
                        >
                          <span class={`method-tag tree-method method-${request.method.toLowerCase()}`}>
                            {request.method}
                          </span>
                          <span class="request-name">{request.name}</span>
                        </button>
                        <button
                          class="icon-button danger-icon"
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
        <div class="sidebar-section-head">
          <span>{props.history.length} RECORDS</span>
          <Show when={props.history.length > 0}>
            <button onClick={props.onClearHistory}>Clear</button>
          </Show>
        </div>
        <div class="tree-scroll">
          <Show
            when={props.history.length > 0}
            fallback={
              <div class="sidebar-empty">
                <strong>No recorded flights</strong>
                <span>Completed requests appear here and persist across restarts.</span>
              </div>
            }
          >
            <For each={props.history}>
              {(entry) => (
                <button
                  class="history-item"
                  classList={{ active: entry.id === props.selectedHistoryId }}
                  aria-current={entry.id === props.selectedHistoryId ? 'page' : undefined}
                  onClick={() => props.onHistory(entry.id)}
                >
                  <span class={`method-tag method-${entry.method.toLowerCase()}`}>{entry.method}</span>
                  <span class="history-copy">
                    <strong>{entry.requestName}</strong>
                    <small>
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
