import { mkdir, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

declare const browser: { saveScreenshot(path: string): Promise<string> };

const externalDataDir = process.env.POSTOWL_DATA_DIR;
const dataDir = externalDataDir ?? mkdtempSync(resolve(tmpdir(), 'postowl-e2e-'));
const ownsDataDir = externalDataDir === undefined;
const artifactDir = resolve(process.env.E2E_ARTIFACT_DIR ?? 'artifacts/e2e');

process.env.POSTOWL_DATA_DIR = dataDir;

function sanitizeWebDriverRequest(requestOptions: RequestInit): RequestInit {
  const headers = new Headers(requestOptions.headers);
  headers.delete('Connection');
  headers.delete('Content-Length');
  return { ...requestOptions, headers };
}

export const config = {
  runner: 'local',
  specs: ['./tests/e2e/native.spec.ts'],
  maxInstances: 1,
  maxInstancesPerCapability: 1,
  capabilities: [{ browserName: 'tauri' }],
  services: [[
    '@wdio/tauri-service',
    {
      appBinaryPath: './src-tauri/target/debug/postowl',
      driverProvider: 'embedded',
      env: {
        POSTOWL_DATA_DIR: dataDir,
        GDK_BACKEND: 'x11',
        RUST_LOG: process.env.POSTOWL_E2E_BACKEND_LOG_LEVEL ?? 'warn'
      },
      startTimeout: 60_000,
      commandTimeout: 30_000,
      logLevel: 'warn',
      captureBackendLogs: true,
      backendLogLevel: process.env.POSTOWL_E2E_BACKEND_LOG_LEVEL ?? 'warn',
    }
  ]],
  framework: 'mocha',
  reporters: ['spec'],
  logLevel: 'warn',
  bail: 0,
  waitforTimeout: 10_000,
  connectionRetryTimeout: 60_000,
  connectionRetryCount: 1,
  transformRequest: sanitizeWebDriverRequest,
  mochaOpts: {
    ui: 'bdd',
    timeout: 120_000
  },
  async onPrepare() {
    await mkdir(dataDir, { recursive: true });
  },
  async afterTest(test: { title: string }, _context: unknown, result: { passed: boolean }) {
    if (result.passed) return;
    try {
      await mkdir(artifactDir, { recursive: true });
      const safeTitle = test.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
      await browser.saveScreenshot(resolve(artifactDir, `${safeTitle || 'failure'}-${Date.now()}.png`));
    } catch (error) {
      console.error('Unable to capture E2E failure screenshot:', error);
    }
  },
  async onComplete() {
    if (ownsDataDir) await rm(dataDir, { recursive: true, force: true });
  }
};
