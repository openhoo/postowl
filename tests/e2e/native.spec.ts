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
  keys(value: string): Promise<void>;
  reloadSession(): Promise<void>;
  refresh(): Promise<void>;
}

interface Expectation {
  not: Expectation;
  toBeDisplayed(): Promise<void>;
  toExist(): Promise<void>;
  toHaveText(expected: unknown): Promise<void>;
  toHaveValue(expected: unknown): Promise<void>;
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

type Workspace = {
  collections: Array<{ id: string; name: string }>;
  requests: Array<{ id: string; name: string; collectionId: string | null }>;
  environments: Array<{ id: string; name: string }>;
  history: Array<{ id: string; requestName: string }>;
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

async function waitForWorkspace() {
  await expect($('h1=Ready for a request')).toBeDisplayed();
}

async function clickSettingsTab(name: 'query' | 'headers' | 'body' | 'scripts') {
  await aria('Request settings').$(`button=${name}`).click();
}

async function setNamedRow(keyLabel: string, valueLabel: string, name: string, value: string, index = 0) {
  const keys = await $$(`[aria-label="${keyLabel}"]`);
  const values = await $$(`[aria-label="${valueLabel}"]`);
  await keys[index].setValue(name);
  await values[index].setValue(value);
}

async function addEnvironmentVariable(name: string, value: string) {
  await button('Add variable').click();
  const variables = await $$('[aria-label="Variable"]');
  await setNamedRow('Variable', 'Value', name, value, variables.length - 1);
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
        const payload = JSON.stringify({
          method: request.method,
          path: url.pathname,
          query: Object.fromEntries(url.searchParams),
          headers: request.headers,
          body
        });
        response.writeHead(201, {
          'content-type': 'application/json',
          'x-echo-server': 'postowl-e2e',
          'content-length': Buffer.byteLength(payload)
        });
        response.end(payload);
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
    const collectionName = aria('Collection name');
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

    await button('Add parameter').click();
    await setNamedRow('Parameter', 'Value', 'source', '{{source}}');
    await clickSettingsTab('headers');
    await button('Add header').click();
    await setNamedRow('Header', 'Value', 'x-client', 'native-ui');
    await clickSettingsTab('body');
    await aria('Body mode').$('button=json').click();
    await aria('Request body').setValue('{"message":"{{message}}","count":2}');
    await button('Save').click();
    await expect($('[role="status"]')).toHaveText('Request saved');

    await button('Environments').click();
    await button('Create environment').click();
    await expect(aria('Environment editor')).toBeDisplayed();
    await aria('Environment name').setValue('Local echo');
    await setNamedRow('Variable', 'Value', 'host', echoOrigin);
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

    await sendAndWaitFor('201');
    const telemetry = aria('Response telemetry');
    await expect(telemetry).toHaveText(expect.stringMatching(/Elapsed\s*\d+\s+ms/));
    await expect(telemetry).toHaveText(expect.stringContaining('1/2'));
    const responseBody = $('.response-body');
    await expect(responseBody).toHaveText(expect.stringContaining('"method": "POST"'));
    await expect(responseBody).toHaveText(expect.stringContaining('"source": "environment"'));
    await expect(responseBody).toHaveText(expect.stringContaining('"x-client": "native-ui"'));
    await expect(responseBody).toHaveText(expect.stringContaining('"x-script": "quickjs"'));
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

    await button('History').click();
    await expect($('.sidebar-section-head')).toHaveText(expect.stringContaining('1 RECORDS'));
    await $('.history-item').click();
    await expect($('.history-title h1')).toHaveText('Echo request');
    await expect($('.response-body')).toHaveText(expect.stringContaining('from-script'));

    await browser.reloadSession();
    await browser.tauri.switchWindow('main');
    await browser.refresh();
    await expect(aria('Request editor')).toBeDisplayed();
    await expect(aria('Request name')).toHaveValue('Echo request');
    await expect(aria('HTTP method')).toHaveValue('POST');
    await button('History').click();
    await expect($('.sidebar-section-head')).toHaveText(expect.stringContaining('1 RECORDS'));
    await $('.history-item').click();
    await expect($('.history-title h1')).toHaveText('Echo request');
    await button('Workspace').click();

    await clickSettingsTab('scripts');
    await aria('Script stage').$('button=Before request').click();
    await aria('Pre-request script').setValue('');
    await clickSettingsTab('query');

    await aria('Request URL').setValue('not a valid URL');
    await sendAndWaitFor('ERR');
    await expect($('[role="alert"]')).toHaveText(expect.stringContaining('Request failed'));

    await aria('Request URL').setValue(`${echoOrigin}/echo`);
    await clickSettingsTab('body');
    await aria('Request body').setValue('{ invalid json');
    await button('Send').click();
    await expect($('[role="alert"]')).toHaveText(expect.stringContaining('invalid JSON request body'));

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
    await expect($('.response-body')).toHaveText(expect.stringContaining('"recovered": true'));

    await aria('New unfiled request').click();
    await aria('Request name').setValue('Disposable request');
    await button('Save').click();
    await expect($('[role="status"]')).toHaveText('Request saved');

    const workspaceValue = await nativeInvoke('get_workspace');
    if (!isWorkspace(workspaceValue)) throw new Error('Native workspace response was invalid');
    const disposable = workspaceValue.requests.find((request) => request.name === 'Disposable request');
    const collection = workspaceValue.collections.find((item) => item.name === 'Echo collection');
    const environment = workspaceValue.environments.find((item) => item.name === 'Local echo');
    if (!disposable || !collection || !environment) throw new Error('Expected persisted cleanup fixtures');

    await expect(button('Delete')).toBeDisplayed();
    await expect(aria('Delete Echo collection')).toBeDisplayed();
    await button('History').click();
    await expect(button('Clear')).toBeDisplayed();

    // Native confirmation dialogs are outside WebDriver control. Exercise the production
    // commands through real IPC, then relaunch and verify their user-visible workspace result.
    await nativeInvoke('delete_request', { id: disposable.id });
    await nativeInvoke('delete_collection', { id: collection.id });
    await nativeInvoke('clear_history');
    await nativeInvoke('delete_environment', { id: environment.id });
    await browser.reloadSession();
    await browser.tauri.switchWindow('main');
    await browser.refresh();

    await waitForWorkspace();
    await expect($('button=Echo request')).not.toExist();
    await expect($('button=Disposable request')).not.toExist();
    await button('History').click();
    await expect($('strong=No recorded flights')).toBeDisplayed();
    await button('Environments').click();
    await expect($('strong=No environments')).toBeDisplayed();
  });
});
