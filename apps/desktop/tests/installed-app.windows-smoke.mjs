import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../../..');
const frontendRequire = createRequire(path.join(repoRoot, 'apps', 'frontend', 'package.json'));
const { chromium, expect } = frontendRequire('@playwright/test');
const artifactsDir = path.join(repoRoot, 'artifacts', 'desktop-smoke');
const appPath = process.env.DESKTOP_APP_PATH;
const cdpPort = Number(process.env.WEBVIEW2_CDP_PORT ?? '9222');
const cdpUrl = `http://127.0.0.1:${cdpPort}`;
let appProcess;
let browser;

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function attempt() {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.end();
        resolve();
      });
      socket.once('error', (error) => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(error);
          return;
        }
        setTimeout(attempt, 250);
      });
    }
    attempt();
  });
}

function stopApp() {
  if (!appProcess || appProcess.exitCode !== null) {
    return;
  }

  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(appProcess.pid), '/T', '/F'], {
      stdio: 'ignore',
    });
  } else {
    appProcess.kill('SIGTERM');
  }
}

async function waitForPage() {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const page = browser
      .contexts()
      .flatMap((context) => context.pages())
      .find((candidate) => candidate.url() !== 'about:blank');
    if (page) {
      return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('Timed out waiting for the Tauri WebView2 page');
}

async function tauriInvoke(page, command) {
  return page.evaluate(async (cmd) => {
    const invoke = window.__TAURI_INTERNALS__?.invoke ?? window.__TAURI__?.invoke;
    if (!invoke) return null;
    return invoke(cmd);
  }, command);
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('The WebView2 CDP smoke test only supports Windows');
  }
  if (!appPath || !fs.existsSync(appPath)) {
    throw new Error(`DESKTOP_APP_PATH does not exist: ${appPath}`);
  }

  fs.mkdirSync(artifactsDir, { recursive: true });
  const appLog = fs.openSync(path.join(artifactsDir, 'windows-app.log'), 'a');
  const env = {
    ...process.env,
    ZVEC_HOST: process.env.ZVEC_HOST ?? '127.0.0.1',
    ZVEC_PORT: process.env.ZVEC_PORT ?? '17862',
    ZVEC_READY_TIMEOUT_SECS: process.env.ZVEC_READY_TIMEOUT_SECS ?? '60',
    ZVEC_STUDIO_DATA_DIR:
      process.env.ZVEC_STUDIO_DATA_DIR ?? path.join(artifactsDir, 'windows-data'),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${cdpPort}`,
  };

  appProcess = spawn(appPath, [], {
    env,
    stdio: ['ignore', appLog, appLog],
  });
  appProcess.once('exit', (code, signal) => {
    if (code && code !== 0) {
      console.error(`installed app exited with code ${code}`);
    }
    if (signal) {
      console.error(`installed app exited via signal ${signal}`);
    }
  });

  await waitForPort(cdpPort, 60000);
  browser = await chromium.connectOverCDP(cdpUrl);
  const page = await waitForPage();
  await expect(page.getByTestId('app-shell')).toBeVisible({ timeout: 60000 });

  await expect
    .poll(async () => (await tauriInvoke(page, 'sidecar_status'))?.running, {
      timeout: 60000,
      message: 'sidecar_status did not report a running sidecar',
    })
    .toBe(true);
  const status = await tauriInvoke(page, 'sidecar_status');
  assert.equal(status.running, true);
  assert.match(status.base_url, /^http:\/\/127\.0\.0\.1:\d+$/);

  const suffix = Date.now().toString(36);
  const collectionName = `uitest${suffix}`;
  const collectionPath = path.join(os.tmpdir(), `zvec-${collectionName}`);

  await page.getByTestId('zv-welcome-create').click();
  await page.getByTestId('zv-create-name').fill(collectionName);
  await page.getByTestId('zv-create-path').fill(collectionPath);
  await page.getByTestId('zv-create-submit').click();

  await expect(page.getByTestId('zv-detail-tab-overview')).toBeVisible({
    timeout: 60000,
  });
  assert.equal(new URL(page.url()).pathname, `/collections/${collectionName}`);

  for (const tabName of ['overview', 'browse', 'query', 'write']) {
    const tab = page.getByTestId(`zv-detail-tab-${tabName}`);
    await tab.click();
    await expect(tab).toHaveClass(/zv-detail-tab--active/, { timeout: 30000 });
  }

  console.log('installed Windows desktop UI smoke: ok');
}

try {
  await main();
} finally {
  await browser?.close().catch(() => {});
  stopApp();
}
