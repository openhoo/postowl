import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

interface NativeElement {
  $(selector: string): NativeElement;
  click(): Promise<void>;
  setValue(value: string): Promise<void>;
}

interface NativeBrowser {
  execute<T>(script: () => T): Promise<T>;
  executeAsync<T>(
    script: (
      nativeCommand: string,
      nativeArgs: Record<string, unknown>,
      done: (value: T) => void
    ) => void,
    command: string,
    args: Record<string, unknown>
  ): Promise<T>;
  tauri: {
    switchWindow(label: string): Promise<void>;
  };
  keys(value: string | string[]): Promise<void>;
  reloadSession(): Promise<void>;
  refresh(): Promise<void>;
}

interface Expectation {
  not: Expectation;
  toBeDisplayed(): Promise<void>;
  toExist(): Promise<void>;
  toHaveText(expected: unknown): Promise<void>;
  toHaveValue(expected: unknown): Promise<void>;
  toHaveAttribute(name: string, value: unknown): Promise<void>;
  toBeFocused(): Promise<void>;
}

interface ExpectFunction {
  (actual: unknown): Expectation;
  stringContaining(value: string): unknown;
  stringMatching(value: RegExp): unknown;
}

declare const browser: NativeBrowser;
declare const $: (selector: string) => NativeElement;
declare const $$: (selector: string) => Promise<NativeElement[]>;
declare const expect: ExpectFunction;
declare function describe(name: string, suite: () => void): void;
declare function it(name: string, test: () => Promise<void>): void;
declare function before(hook: () => Promise<void>): void;
declare function after(hook: () => Promise<void>): void;

type NamedValue = { id: string; name: string; value: string; enabled: boolean };
type PersistedRequest = {
  id: string;
  name: string;
  collectionId: string | null;
  method: string;
  url: string;
  headers: NamedValue[];
  query: NamedValue[];
  bodyMode: string;
  body: string;
  preRequestScript: string;
  postResponseScript: string;
};
type PersistedResponse = {
  status: number | null;
  headers: Array<{ name: string; value: string; encoding: 'utf8' | 'base64' }>;
  body: string;
  bodyEncoding: 'utf8' | 'base64';
  elapsed: number;
  size: number;
  totalSize: number | null;
  truncated: boolean;
  assertions: Array<{ name: string; passed: boolean; message: string }>;
  logs: string[];
  error: string | null;
};
type Workspace = {
  collections: Array<{ id: string; name: string }>;
  requests: PersistedRequest[];
  environments: Array<{ id: string; name: string; variables: NamedValue[] }>;
  history: Array<{
    id: string;
    requestId: string;
    requestName: string;
    method: string;
    url: string;
    response: PersistedResponse;
  }>;
};

function isWorkspace(value: unknown): value is Workspace {
  if (!value || typeof value !== 'object') return false;
  if (!('collections' in value) || !Array.isArray(value.collections)) return false;
  if (!('requests' in value) || !Array.isArray(value.requests)) return false;
  if (!('environments' in value) || !Array.isArray(value.environments)) return false;
  if (!('history' in value) || !Array.isArray(value.history)) return false;
  const validEntity = (item: unknown) => {
    if (!item || typeof item !== 'object' || !('id' in item) || !('name' in item)) return false;
    return typeof item.id === 'string' && typeof item.name === 'string';
  };
  return value.collections.every(validEntity) &&
    value.requests.every(validEntity) &&
    value.environments.every(validEntity) &&
    value.history.every((item: unknown) =>
      Boolean(item && typeof item === 'object' && 'id' in item && typeof item.id === 'string' &&
        'requestName' in item && typeof item.requestName === 'string')
    );
}

let echoServer: Server;
let echoOrigin = '';

const aria = (name: string) => $(`[aria-label="${name}"]`);
const button = (text: string) => $(`button*=${text}`);

function assertContract(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Persisted contract failed: ${message}`);
}

async function refreshRenderer(expectedSelector: string) {
  await browser.refresh();
  await browser.tauri.switchWindow('main');
  await expect($(expectedSelector)).toBeDisplayed();
}


async function waitForWorkspace() {
  await expect($('h1=Ready for a request')).toBeDisplayed();
}

async function clickSettingsTab(name: 'query' | 'headers' | 'body' | 'scripts') {
  await aria('Request settings').$(`button=${name}`).click();
}

async function setNamedRow(kind: string, name: string, value: string, index = 0) {
  const position = index + 1;
  await aria(`${kind} ${position} name`).setValue(name);
  await aria(`${kind} ${position} value`).setValue(value);
}

async function addEnvironmentVariable(name: string, value: string) {
  const variables = await $$('[aria-label^="Variable "][aria-label$=" name"]');
  await button('Add variable').click();
  await setNamedRow('Variable', name, value, variables.length);
}

async function sendAndWaitFor(status: string) {
  await button('Send').click();
  await expect(aria('Response telemetry')).toBeDisplayed();
  await expect(aria('Response telemetry').$('strong')).toHaveText(status);
}

async function nativeInvoke(command: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const result: unknown = await browser.executeAsync(
    (nativeCommand: string, nativeArgs: Record<string, unknown>, done: (value: unknown) => void) => {
      const root: object = globalThis;
      if (!('__TAURI_INTERNALS__' in root) || !root.__TAURI_INTERNALS__ ||
          typeof root.__TAURI_INTERNALS__ !== 'object' || !('invoke' in root.__TAURI_INTERNALS__) ||
          typeof root.__TAURI_INTERNALS__.invoke !== 'function') {
        done({ ok: false, error: 'Tauri invoke bridge is unavailable' });
        return;
      }
      const invoke = root.__TAURI_INTERNALS__.invoke as (
        command: string,
        args: Record<string, unknown>
      ) => Promise<unknown>;
      invoke(nativeCommand, nativeArgs).then(
        (value) => done({ ok: true, value }),
        (error) => done({ ok: false, error: String(error) })
      );
    },
    command,
    args
  );

  if (!result || typeof result !== 'object' || !('ok' in result) || typeof result.ok !== 'boolean') {
    throw new Error(`Native command ${command} returned an invalid result`);
  }
  if (!result.ok) {
    const message = 'error' in result && typeof result.error === 'string' ? result.error : 'unknown error';
    throw new Error(`Native command ${command} failed: ${message}`);
  }
  return 'value' in result ? result.value : undefined;
}

describe('PostOwl native workspace', () => {
  before(async () => {
    echoServer = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let body: unknown = rawBody;
        try { body = JSON.parse(rawBody); } catch { /* Echo non-JSON bodies unchanged. */ }
        const url = new URL(request.url ?? '/', echoOrigin);
        const serialized = JSON.stringify({
          method: request.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          headers: request.headers,
          body
        });
        const payload = `{"largeId":9007199254740993,${serialized.slice(1)}`;
        const finish = () => {
          let responseBody: string | Buffer = payload;
          let contentType = 'application/json';
          if (url.pathname === '/html') {
            responseBody = '<!doctype html><html><body><main><h1>Flight preview</h1><p>Rendered safely.</p></main></body></html>';
            contentType = 'text/html; charset=utf-8';
          } else if (url.pathname === '/xml') {
            responseBody = '<?xml version="1.0"?><flight><status>ready</status><crew count="2"/></flight>';
            contentType = 'application/xml';
          } else if (url.pathname === '/image') {
            responseBody = Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
              'base64'
            );
            contentType = 'image/png';
          }
          response.writeHead(201, {
            'content-type': contentType,
            'x-echo-server': 'postowl-e2e',
            'content-length': Buffer.byteLength(responseBody)
          });
          response.end(responseBody);
        };
        if (url.pathname === '/delayed') setTimeout(finish, 250);
        else finish();
      });
    });
    await new Promise<void>((resolve, reject) => {
      echoServer.once('error', reject);
      echoServer.listen(0, '127.0.0.1', resolve);
    });
    const { port } = echoServer.address() as AddressInfo;
    echoOrigin = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) => echoServer.close((error) => error ? reject(error) : resolve()));
  });

  it('exercises persistence, HTTP, variables, scripts, errors, history, and cleanup', async () => {
    await browser.tauri.switchWindow('main');
    await waitForWorkspace();
    await expect(aria('Collection name')).not.toExist();
    await expect(aria('Request editor')).not.toExist();
    await expect($('.sidebar-section-head')).toHaveText(expect.stringContaining('COLLECTIONS'));
    await expect($('.collection-label')).toHaveText('Unfiled');
    await button('History').click();
    await expect($('strong=No recorded flights')).toBeDisplayed();
    await button('Workspace').click();

    await $('button[title="New collection"]').click();
    const collectionName = aria('Collection name for Untitled collection');
    await expect(collectionName).toBeDisplayed();
    await collectionName.setValue('Echo collection');
    await browser.keys('Enter');
    await expect($('[role="status"]')).toHaveText('Collection renamed');

    await aria('New request in Echo collection').click();
    await expect(aria('Request editor')).toBeDisplayed();
    await aria('Request name').setValue('Echo request');
    await browser.execute(() => {
      const select = document.querySelector<HTMLSelectElement>('[aria-label="HTTP method"]');
      if (!select) throw new Error('HTTP method selector is missing');
      select.value = 'POST';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await expect(aria('HTTP method')).toHaveValue('POST');
    await aria('Request URL').setValue(`${echoOrigin}/echo`);
    const queryTab = aria('Request settings').$('button=query');
    const headersTab = aria('Request settings').$('button=headers');
    await queryTab.click();
    await browser.keys('ArrowRight');
    await expect(headersTab).toHaveAttribute('aria-selected', 'true');
    await expect(headersTab).toBeFocused();
    await browser.execute(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
    await expect(queryTab).toHaveAttribute('aria-selected', 'true');
    await expect(queryTab).toBeFocused();

    await button('Add parameter').click();
    await setNamedRow('Query parameter', 'source', '{{source}}');
    await clickSettingsTab('headers');
    await button('Add header').click();
    await setNamedRow('Header', 'x-client', 'native-ui');
    await clickSettingsTab('body');
    await aria('Body mode').$('button=json').click();
    await aria('Request body').setValue('{"message":"{{message}}","count":2}');
    await button('Save').click();
    await expect($('[role="status"]')).toHaveText('Request saved');
    await refreshRenderer('[aria-label="Request editor"]');
    await expect(aria('Request name')).toHaveValue('Echo request');
    await expect(aria('HTTP method')).toHaveValue('POST');
    await expect(aria('Request URL')).toHaveValue(`${echoOrigin}/echo`);

    await button('Environments').click();
    await button('Create environment').click();
    await expect(aria('Environment editor')).toBeDisplayed();
    await aria('Environment name').setValue('Local echo');
    await button('Add variable').click();
    await expect(aria('Variable 1 value')).toHaveAttribute('type', 'password');
    await setNamedRow('Variable', 'host', echoOrigin);
    await addEnvironmentVariable('source', 'environment');
    await addEnvironmentVariable('message', 'before-script');
    await button('Save environment').click();
    await expect($('[role="status"]')).toHaveText('Environment saved');
    await aria('Open workspace').click();

    await clickSettingsTab('scripts');
    await aria('Pre-request script').setValue(`
      return {
        request: {
          ...ctx.request,
          url: '{{host}}/echo',
          headers: [...ctx.request.headers, { id: 'script-header', name: 'x-script', value: 'quickjs', enabled: true }]
        },
        variables: { ...ctx.variables, message: 'from-script' },
        logs: ['pre hook ran']
      };
    `);
    await aria('Script stage').$('button=After response').click();
    await aria('Post-response script').setValue(`
      const echoed = JSON.parse(ctx.response.body);
      return {
        assertions: [
          { name: 'status is 201', passed: ctx.response.status === 201, message: '' },
          { name: 'intentional failure', passed: false, message: 'expected intentional failure' }
        ],
        logs: ['post status ' + ctx.response.status]
      };
    `);

    await aria('Request URL').click();
    await browser.execute(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await expect(aria('Response telemetry')).toBeDisplayed();
    await expect(aria('Response telemetry').$('strong')).toHaveText('201');
    const telemetry = aria('Response telemetry');
    await expect(telemetry).toHaveText(expect.stringMatching(/Elapsed\s*\d+\s+ms/));
    await expect(telemetry).toHaveText(expect.stringContaining('1/2'));
    await expect(aria('Response body view').$('button=JSON')).toHaveAttribute('aria-pressed', 'true');
    const responseBody = $('.response-body');
    await expect(responseBody).toHaveText(expect.stringContaining('"method": "POST"'));
    await expect(responseBody).toHaveText(expect.stringContaining('"source": "environment"'));
    await expect(responseBody).toHaveText(expect.stringContaining('"x-client": "native-ui"'));
    await expect(responseBody).toHaveText(expect.stringContaining('"x-script": "quickjs"'));
    await expect(responseBody).toHaveText(expect.stringContaining('"largeId": 9007199254740993'));
    await expect(responseBody).toHaveText(expect.stringContaining('"message": "from-script"'));

    await aria('Response details').$('button*=headers').click();
    await expect($('.header-list')).toHaveText(expect.stringContaining('x-echo-server'));
    await expect($('.header-list')).toHaveText(expect.stringContaining('postowl-e2e'));
    await aria('Response details').$('button*=assertions').click();
    const assertionRows = await $$('.assertion-list li');
    await expect(assertionRows[0]).toHaveText(expect.stringContaining('PASS'));
    await expect(assertionRows[0]).toHaveText(expect.stringContaining('status is 201'));
    await expect(assertionRows[1]).toHaveText(expect.stringContaining('FAIL'));
    await expect(assertionRows[1]).toHaveText(expect.stringContaining('intentional failure'));
    await expect(assertionRows[1]).toHaveText(expect.stringContaining('expected intentional failure'));
    await aria('Response details').$('button*=logs').click();
    await expect($('.log-list')).toHaveText(expect.stringContaining('pre hook ran'));
    await expect($('.log-list')).toHaveText(expect.stringContaining('post status 201'));
    const responseBodyTab = aria('Response details').$('button*=body');
    const responseLogsTab = aria('Response details').$('button*=logs');
    await responseBodyTab.click();
    await browser.execute(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true })));
    await expect(responseLogsTab).toHaveAttribute('aria-selected', 'true');
    await browser.execute(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })));
    await expect(responseBodyTab).toHaveAttribute('aria-selected', 'true');
    const stackLayout = await browser.execute(() => {
      const request = document.querySelector('[aria-label="Request editor"]')?.getBoundingClientRect();
      const response = document.querySelector('.response-panel')?.getBoundingClientRect();
      if (!request || !response) throw new Error('Workbench panels are missing');
      return { requestBottom: request.bottom, responseTop: response.top };
    });
    assertContract(stackLayout.responseTop >= stackLayout.requestBottom - 1, 'response panel is below request editor');

    const seededValue = await nativeInvoke('get_workspace');
    if (!isWorkspace(seededValue)) throw new Error('Native workspace response was invalid');
    const seededCollection = seededValue.collections.find((item) => item.name === 'Echo collection');
    const seededRequest = seededValue.requests.find((item) => item.name === 'Echo request');
    const seededEnvironment = seededValue.environments.find((item) => item.name === 'Local echo');
    const seededHistory = seededValue.history.find((item) => item.requestName === 'Echo request');
    assertContract(seededCollection && seededRequest && seededEnvironment && seededHistory, 'seeded entities exist');
    assertContract(seededRequest.collectionId === seededCollection.id, 'request collection membership');
    assertContract(seededRequest.method === 'POST', 'request method');
    assertContract(seededRequest.url === `${echoOrigin}/echo`, 'request URL');
    assertContract(seededRequest.bodyMode === 'json', 'request body mode');
    assertContract(seededRequest.body === '{"message":"{{message}}","count":2}', 'request body');
    assertContract(
      seededRequest.query.length === 1 &&
      seededRequest.query[0].name === 'source' &&
      seededRequest.query[0].value === '{{source}}' &&
      seededRequest.query[0].enabled,
      'request query parameters'
    );
    assertContract(
      seededRequest.headers.length === 1 &&
      seededRequest.headers[0].name === 'x-client' &&
      seededRequest.headers[0].value === 'native-ui' &&
      seededRequest.headers[0].enabled,
      'request headers'
    );
    assertContract(seededRequest.preRequestScript.includes("logs: ['pre hook ran']"), 'pre-request script');
    assertContract(seededRequest.postResponseScript.includes('intentional failure'), 'post-response script');
    assertContract(
      seededEnvironment.variables.map(({ name, value, enabled }) => ({ name, value, enabled }))
        .every((variable, index) => {
          const expected = [
            { name: 'host', value: echoOrigin, enabled: true },
            { name: 'source', value: 'environment', enabled: true },
            { name: 'message', value: 'from-script', enabled: true }
          ][index];
          return expected && variable.name === expected.name &&
            variable.value === expected.value && variable.enabled === expected.enabled;
        }) && seededEnvironment.variables.length === 3,
      'environment variables'
    );
    assertContract(seededHistory.requestId === seededRequest.id, 'history request identity');
    assertContract(seededHistory.method === 'POST' && seededHistory.url === `${echoOrigin}/echo?source=environment`, 'history request metadata');
    assertContract(seededHistory.response.status === 201, 'history response status');
    assertContract(seededHistory.response.error === null && !seededHistory.response.truncated, 'history response completion');
    assertContract(seededHistory.response.size > 0, 'history captured response size');
    assertContract(seededHistory.response.body.includes('"largeId":9007199254740993'), 'history response body');
    assertContract(seededHistory.response.totalSize === seededHistory.response.size, 'history total response size');
    assertContract(seededHistory.response.bodyEncoding === 'utf8', 'history response body encoding');
    assertContract(
      seededHistory.response.headers.some(({ name, value }) => name === 'x-echo-server' && value === 'postowl-e2e'),
      'history response headers'
    );
    assertContract(
      seededHistory.response.headers.every(({ encoding }) => encoding === 'utf8'),
      'history response header encodings'
    );
    assertContract(
      seededHistory.response.assertions.length === 2 &&
      seededHistory.response.assertions[0].name === 'status is 201' &&
      seededHistory.response.assertions[0].passed &&
      seededHistory.response.assertions[1].name === 'intentional failure' &&
      !seededHistory.response.assertions[1].passed &&
      seededHistory.response.assertions[1].message === 'expected intentional failure',
      'history assertions'
    );
    assertContract(
      seededHistory.response.logs.includes('pre hook ran') &&
      seededHistory.response.logs.includes('post status 201'),
      'history script logs'
    );

    await button('History').click();
    await expect($('.sidebar-section-head')).toHaveText(expect.stringContaining('1 RECORDS'));
    await $('.history-item').click();
    await expect($('.history-title h1')).toHaveText('Echo request');
    await expect($('.response-body')).toHaveText(expect.stringContaining('from-script'));

    await refreshRenderer('[aria-label="Request editor"]');
    await expect(aria('Request name')).toHaveValue('Echo request');
    await expect(aria('HTTP method')).toHaveValue('POST');
    await button('History').click();
    await expect($('.sidebar-section-head')).toHaveText(expect.stringContaining('1 RECORDS'));
    await $('.history-item').click();
    await expect($('.history-title h1')).toHaveText('Echo request');
    const relaunchedValue = await nativeInvoke('get_workspace');
    if (!isWorkspace(relaunchedValue)) throw new Error('Relaunched native workspace response was invalid');
    assertContract(
      relaunchedValue.collections.some(({ id }) => id === seededCollection.id) &&
      relaunchedValue.requests.some(({ id }) => id === seededRequest.id) &&
      relaunchedValue.environments.some(({ id }) => id === seededEnvironment.id) &&
      relaunchedValue.history.some(({ id }) => id === seededHistory.id),
      'stable entity IDs across renderer reloads'
    );
    await button('Workspace').click();
    await browser.execute(() => {
      const select = document.querySelector<HTMLSelectElement>('.environment-select select');
      const option = Array.from(select?.options ?? []).find((item) => item.text === 'Local echo');
      if (!select || !option) throw new Error('Local echo environment option is missing');
      select.value = option.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await button('Environments').click();
    await expect(aria('Variable 3 value')).toHaveValue('from-script');
    await aria('Open workspace').click();

    await clickSettingsTab('scripts');
    await aria('Script stage').$('button=Before request').click();
    await aria('Pre-request script').setValue('');
    await clickSettingsTab('query');

    await aria('Request URL').setValue('not a valid URL');
    await button('Send').click();
    await expect($('[role="alert"]')).toHaveText('Enter a valid HTTP or HTTPS URL.');
    await expect(aria('Request URL')).toBeFocused();
    await aria('Request URL').setValue(`${echoOrigin}/echo`);
    await clickSettingsTab('query');
    await button('Add parameter').click();
    await button('Send').click();
    await expect($('[role="alert"]')).toHaveText('Enter a query parameter name.');
    await expect(aria('Query parameter 2 name')).toBeFocused();
    await aria('Enable Query parameter 2').click();
    await clickSettingsTab('body');
    await aria('Request body').setValue('{ invalid json');
    await button('Send').click();
    await expect($('[role="alert"]')).toHaveText(expect.stringContaining('Enter valid JSON.'));

    await expect(aria('Request body')).toBeFocused();
    await aria('Request body').setValue('{"recovered":true}');
    await clickSettingsTab('scripts');
    await aria('Script stage').$('button=Before request').click();
    await aria('Pre-request script').setValue('return {');
    await button('Send').click();
    await expect($('[role="alert"]')).toHaveText(expect.stringContaining('script'));

    await aria('Pre-request script').setValue("return { request: ctx.request, variables: ctx.variables, logs: ['recovered'] };");
    await aria('Script stage').$('button=After response').click();
    await aria('Post-response script').setValue("return { assertions: [{ name: 'recovery', passed: true, message: '' }], logs: ['valid again'] };");
    await sendAndWaitFor('201');
    await aria('Response details').$('button*=body').click();
    await expect(aria('Response body view').$('button=JSON')).toHaveAttribute('aria-pressed', 'true');
    await expect($('.response-body')).toHaveText(expect.stringContaining('"recovered": true'));

    await aria('Request URL').setValue(`${echoOrigin}/html`);
    await sendAndWaitFor('201');
    await expect(aria('Response body view').$('button=HTML')).toHaveAttribute('aria-pressed', 'true');
    await expect($('.response-html')).toHaveAttribute('srcdoc', expect.stringContaining('Flight preview'));

    await aria('Request URL').setValue(`${echoOrigin}/xml`);
    await sendAndWaitFor('201');
    await expect(aria('Response body view').$('button=XML')).toHaveAttribute('aria-pressed', 'true');
    await expect($('.response-body')).toHaveText(expect.stringContaining('<status>ready</status>'));

    await aria('Request URL').setValue(`${echoOrigin}/image`);
    await sendAndWaitFor('201');
    await expect(aria('Response body view').$('button=Image')).toHaveAttribute('aria-pressed', 'true');
    await expect($('.response-image img')).toHaveAttribute('src', expect.stringMatching(/^data:image\/png;base64,/));

    await aria('New unfiled request').click();
    await aria('Request name').setValue('Disposable request');
    await aria('Request URL').setValue(`${echoOrigin}/disposable`);
    await button('Save').click();
    await expect($('[role="status"]')).toHaveText('Request saved');

    await aria('Request URL').setValue(`${echoOrigin}/delayed`);
    await button('Save').click();
    await expect($('[role="status"]')).toHaveText('Request saved');
    await button('Send').click();
    await aria('Echo request in Echo collection').click();
    await expect(aria('Request name')).toHaveValue('Echo request');
    await expect($('[role="status"]')).toHaveText('Response recorded');
    await expect(aria('Response telemetry')).not.toExist();
    await aria('Disposable request, unfiled').click();
    await aria('Request editor').$('button=Delete').click();
    await expect($('[role="alertdialog"]')).toHaveText(expect.stringContaining('Delete “Disposable request”?'));
    await button('Cancel').click();
    await expect(aria('Request name')).toHaveValue('Disposable request');
    await aria('Request editor').$('button=Delete').click();
    await $('[role="alertdialog"]').$('button=Delete request').click();
    await expect($('[role="status"]')).toHaveText('Request deleted');
    await expect(aria('Disposable request, unfiled')).not.toExist();


    const workspaceValue = await nativeInvoke('get_workspace');
    if (!isWorkspace(workspaceValue)) throw new Error('Native workspace response was invalid');
    const collection = workspaceValue.collections.find((item) => item.name === 'Echo collection');
    const environment = workspaceValue.environments.find((item) => item.name === 'Local echo');
    if (!collection || !environment) throw new Error('Expected persisted cleanup fixtures');

    await expect(aria('Delete collection Echo collection')).toBeDisplayed();
    await button('History').click();
    await expect(button('Clear')).toBeDisplayed();

    // Keep teardown for the unrelated collection, history, and environment fixtures
    // separate from the request-deletion UI contract above.
    await nativeInvoke('delete_collection', { id: collection.id });
    await nativeInvoke('clear_history');
    await nativeInvoke('delete_environment', { id: environment.id });
    await refreshRenderer('h1=Ready for a request');
    await expect($('button=Echo request')).not.toExist();
    await expect(aria('Disposable request, unfiled')).not.toExist();
    await button('History').click();
    await expect($('strong=No recorded flights')).toBeDisplayed();
    await button('Environments').click();
    await expect($('strong=No environments')).toBeDisplayed();
  });
});
