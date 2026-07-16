import { mkdir, rm } from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

declare const browser: { saveScreenshot(path: string): Promise<string> };

const dataDir = mkdtempSync(resolve(tmpdir(), 'postowl-e2e-'));
const artifactDir = resolve(process.env.E2E_ARTIFACT_DIR ?? 'artifacts/e2e');

process.env.POSTOWL_DATA_DIR = dataDir;

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
      env: { POSTOWL_DATA_DIR: dataDir },
      startTimeout: 60_000,
      commandTimeout: 30_000,
      logLevel: 'warn'
    }
  ]],
  framework: 'mocha',
  reporters: ['spec'],
  logLevel: 'warn',
  bail: 0,
  waitforTimeout: 10_000,
  connectionRetryTimeout: 60_000,
  connectionRetryCount: 1,
  mochaOpts: {
    ui: 'bdd',
    timeout: 120_000
  },
  async afterTest(test: { title: string }, _context: unknown, result: { passed: boolean }) {
    if (result.passed) return;
    await mkdir(artifactDir, { recursive: true });
    const safeTitle = test.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();
    await browser.saveScreenshot(resolve(artifactDir, `${safeTitle || 'failure'}-${Date.now()}.png`));
  },
  async onComplete() {
    await rm(dataDir, { recursive: true, force: true });
  }
};
