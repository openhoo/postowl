import type { BodyMode, Collection, Environment, NamedValue, RequestDraft } from './types';

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
export const BODY_MODES: BodyMode[] = ['none', 'text', 'json', 'form'];

export function uid(): string {
  return crypto.randomUUID();
}

export function namedValue(): NamedValue {
  return { id: uid(), name: '', value: '', enabled: true };
}

export function newCollection(): Collection {
  return { id: uid(), name: 'Untitled collection', description: '', createdAt: 0, updatedAt: 0 };
}

export function newRequest(collectionId: string | null): RequestDraft {
  return {
    id: uid(),
    name: 'Untitled request',
    collectionId,
    method: 'GET',
    url: '',
    headers: [],
    query: [],
    bodyMode: 'none',
    body: '',
    preRequestScript: '',
    postResponseScript: '',
    createdAt: 0,
    updatedAt: 0
  };
}

export function newEnvironment(): Environment {
  return { id: uid(), name: 'New environment', variables: [namedValue()], createdAt: 0, updatedAt: 0 };
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function displayError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'The operation could not be completed.';
}

export function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(timestamp));
}

export function statusTone(status: number | null): 'good' | 'bad' | 'neutral' {
  if (status === null) return 'bad';
  if (status >= 200 && status < 400) return 'good';
  if (status >= 400) return 'bad';
  return 'neutral';
}
