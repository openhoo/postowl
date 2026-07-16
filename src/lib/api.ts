import { invoke } from '@tauri-apps/api/core';
import type { Collection, Environment, RequestDraft, ResponseData, Workspace } from './types';

export const commands = {
  getWorkspace: () => invoke<Workspace>('get_workspace'),
  saveCollection: (collection: Collection) => invoke<Collection>('save_collection', { collection }),
  deleteCollection: (id: string) => invoke<void>('delete_collection', { id }),
  saveRequest: (request: RequestDraft) => invoke<RequestDraft>('save_request', { request }),
  deleteRequest: (id: string) => invoke<void>('delete_request', { id }),
  saveEnvironment: (environment: Environment) => invoke<Environment>('save_environment', { environment }),
  deleteEnvironment: (id: string) => invoke<void>('delete_environment', { id }),
  executeRequest: (requestId: string, environmentId: string | null) =>
    invoke<ResponseData>('execute_request', { requestId, environmentId }),
  clearHistory: () => invoke<void>('clear_history'),
  exportWorkspace: (path: string) => invoke<void>('export_workspace', { path }),
  importWorkspace: (path: string) => invoke<Workspace>('import_workspace', { path })
};
