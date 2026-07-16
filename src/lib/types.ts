export type BodyMode = 'none' | 'text' | 'json' | 'form';

export interface NamedValue {
  id: string;
  name: string;
  value: string;
  enabled: boolean;
}

export interface Collection {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
}

export interface RequestDraft {
  id: string;
  name: string;
  collectionId: string | null;
  method: string;
  url: string;
  headers: NamedValue[];
  query: NamedValue[];
  bodyMode: BodyMode;
  body: string;
  preRequestScript: string;
  postResponseScript: string;
  createdAt: number;
  updatedAt: number;
}

export interface Environment {
  id: string;
  name: string;
  variables: NamedValue[];
  createdAt: number;
  updatedAt: number;
}

export interface HeaderValue {
  name: string;
  value: string;
}

export interface AssertionResult {
  name: string;
  passed: boolean;
  message: string;
}

export interface ResponseData {
  status: number | null;
  headers: HeaderValue[];
  body: string;
  elapsed: number;
  size: number;
  truncated: boolean;
  assertions: AssertionResult[];
  logs: string[];
  error: string | null;
}

export interface HistoryEntry {
  id: string;
  requestId: string;
  requestName: string;
  method: string;
  url: string;
  executedAt: number;
  response: ResponseData;
}

export interface Workspace {
  collections: Collection[];
  requests: RequestDraft[];
  environments: Environment[];
  history: HistoryEntry[];
}
