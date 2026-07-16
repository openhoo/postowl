import { For, Show, createSignal } from 'solid-js';
import type { Collection, HistoryEntry, RequestDraft } from '../types';
import { formatTime } from '../utils';
import ActionButton from './ActionButton';

type SidebarMode = 'workspace' | 'history' | 'environments';
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
  onSaveCollection: (collection: Collection) => void;
  onDeleteCollection: (collection: Collection) => void;
  onDeleteRequest: (request: RequestDraft) => void;
  onClearHistory: () => void;
}

export default function Sidebar(props: SidebarProps) {
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({});

  const isExpanded = (collectionId: string) => expanded()[collectionId] !== false;

  return (
    <aside class="sidebar">
      <nav class="sidebar-tabs" aria-label="Workspace navigation">
        <button
          classList={{ active: props.mode === 'workspace' }}
          onClick={() => props.onMode('workspace')}
        >
          Workspace
        </button>
        <button
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
              <ActionButton onClick={props.onNewCollection} title="New collection">
                ＋
              </ActionButton>
            </div>
            <div class="tree-scroll">
              <For each={props.collections}>
                {(collection) => (
                  <section class="collection-node">
                    <div class="collection-row">
                      <button
                        class="disclosure"
                        aria-label={`${isExpanded(collection.id) ? 'Collapse' : 'Expand'} ${collection.name}`}
                        onClick={() =>
                          setExpanded((current) => ({
                            ...current,
                            [collection.id]: !isExpanded(collection.id)
                          }))
                        }
                      >
                        ▾
                      </button>
                      <input
                        value={collection.name}
                        aria-label="Collection name"
                        onBlur={(event) => props.onSaveCollection({ ...collection, name: event.currentTarget.value })}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') event.currentTarget.blur();
                        }}
                      />
                      <button
                        class="icon-button"
                        title="New request"
                        aria-label={`New request in ${collection.name}`}
                        onClick={() => props.onNewRequest(collection.id)}
                      >
                        ＋
                      </button>
                      <button
                        class="icon-button danger-icon"
                        title="Delete collection"
                        aria-label={`Delete ${collection.name}`}
                        onClick={() => props.onDeleteCollection(collection)}
                      >
                        ×
                      </button>
                    </div>
                    <Show when={isExpanded(collection.id)}>
                      <div class="request-tree">
                        <For
                          each={props.requests.filter(
                            (request) => request.collectionId === collection.id
                          )}
                          fallback={
                            <button class="add-first" onClick={() => props.onNewRequest(collection.id)}>
                              ＋ Add first request
                            </button>
                          }
                        >
                          {(request) => (
                            <div
                              class="tree-request"
                              classList={{ active: request.id === props.selectedRequestId }}
                            >
                              <button onClick={() => props.onRequest(request.id)}>
                                <span
                                  class={`method-dot method-${request.method.toLowerCase()}`}
                                ></span>
                                <span>{request.name}</span>
                              </button>
                              <button
                                class="icon-button danger-icon"
                                aria-label={`Delete ${request.name}`}
                                title="Delete request"
                                onClick={() => props.onDeleteRequest(request)}
                              >
                                ×
                              </button>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </section>
                )}
              </For>

              <section class="collection-node unfiled">
                <div class="collection-row">
                  <span class="disclosure">⌁</span>
                  <span class="collection-label">Unfiled</span>
                  <button
                    class="icon-button"
                    title="New unfiled request"
                    aria-label="New unfiled request"
                    onClick={() => props.onNewRequest(null)}
                  >
                    ＋
                  </button>
                </div>
                <div class="request-tree">
                  <For
                    each={props.requests.filter((request) => request.collectionId === null)}
                    fallback={
                      <button class="add-first" onClick={() => props.onNewRequest(null)}>
                        ＋ New request
                      </button>
                    }
                  >
                    {(request) => (
                      <div
                        class="tree-request"
                        classList={{ active: request.id === props.selectedRequestId }}
                      >
                        <button onClick={() => props.onRequest(request.id)}>
                          <span
                            class={`method-dot method-${request.method.toLowerCase()}`}
                          ></span>
                          <span>{request.name}</span>
                        </button>
                        <button
                          class="icon-button danger-icon"
                          aria-label={`Delete ${request.name}`}
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
