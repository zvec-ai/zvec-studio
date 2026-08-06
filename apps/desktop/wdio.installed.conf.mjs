import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, '../..');
const artifactsDir = path.join(repoRoot, 'artifacts', 'desktop-smoke');
const driverPort = Number(process.env.TAURI_DRIVER_PORT ?? '4444');
const webviewDataDir = path.join(artifactsDir, `webview2-${process.pid}-${Date.now()}`);
let driverProcess;
let devToolsActivePortTimer;

function mirrorNestedDevToolsActivePort() {
  const nestedPath = path.join(webviewDataDir, 'EBWebView', 'DevToolsActivePort');
  const expectedPath = path.join(webviewDataDir, 'DevToolsActivePort');
  if (fs.existsSync(expectedPath) || !fs.existsSync(nestedPath)) {
    return;
  }

  try {
    const contents = fs.readFileSync(nestedPath, 'utf8');
    if (contents.trim().split(/\r?\n/).length < 2) {
      return;
    }

    const temporaryPath = `${expectedPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, contents);
    fs.renameSync(temporaryPath, expectedPath);
    clearInterval(devToolsActivePortTimer);
    devToolsActivePortTimer = undefined;
    console.log('Mirrored nested WebView2 DevToolsActivePort for EdgeDriver compatibility');
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.warn(`Could not mirror WebView2 DevToolsActivePort: ${error}`);
    }
  }
}

function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    function attempt() {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => {
        socket.end();
        resolve();
      });
      socket.once('error', (err) => {
        socket.destroy();
        if (Date.now() >= deadline) {
          reject(err);
          return;
        }
        setTimeout(attempt, 250);
      });
    }
    attempt();
  });
}

export const config = {
  runner: 'local',
  hostname: '127.0.0.1',
  port: driverPort,
  path: '/',
  specs: ['./tests/installed-app.smoke.e2e.js'],
  maxInstances: 1,
  capabilities: [
    {
      maxInstances: 1,
      'tauri:options': {
        application: process.env.DESKTOP_APP_PATH,
        webviewOptions: {
          userDataFolder: webviewDataDir,
        },
      },
    },
  ],
  logLevel: 'info',
  bail: 0,
  waitforTimeout: 30000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 1,
  framework: 'mocha',
  reporters: ['spec'],
  outputDir: path.join(artifactsDir, 'wdio'),
  mochaOpts: {
    ui: 'bdd',
    timeout: 120000,
  },
  onPrepare: async () => {
    if (!process.env.DESKTOP_APP_PATH) {
      throw new Error('DESKTOP_APP_PATH is required for installed desktop e2e');
    }
    fs.mkdirSync(artifactsDir, { recursive: true });

    process.env.ZVEC_HOST ||= '127.0.0.1';
    process.env.ZVEC_PORT ||= '17862';
    process.env.ZVEC_READY_TIMEOUT_SECS ||= '60';
    process.env.ZVEC_STUDIO_DATA_DIR ||= path.join(artifactsDir, 'wdio-data');
    process.env.NO_AT_BRIDGE ||= '1';
    process.env.WEBKIT_DISABLE_DMABUF_RENDERER ||= '1';

    fs.mkdirSync(webviewDataDir, { recursive: true });
    // Edge/WebView2 150 may create this file under EBWebView while EdgeDriver
    // still waits for it at the configured user-data root. See:
    // https://github.com/MicrosoftEdge/EdgeWebDriver/issues/109
    devToolsActivePortTimer = setInterval(mirrorNestedDevToolsActivePort, 100);
    devToolsActivePortTimer.unref();

    const logPath = path.join(artifactsDir, 'tauri-driver.log');
    const logFd = fs.openSync(logPath, 'a');
    driverProcess = spawn(
      process.env.TAURI_DRIVER ?? 'tauri-driver',
      ['--port', String(driverPort)],
      {
        env: process.env,
        stdio: ['ignore', logFd, logFd],
      },
    );
    driverProcess.once('exit', (code, signal) => {
      if (code !== null && code !== 0) {
        console.error(`tauri-driver exited with code ${code}`);
      }
      if (signal) {
        console.error(`tauri-driver exited via signal ${signal}`);
      }
    });
    await waitForPort(driverPort, 30000);
  },
  onComplete: () => {
    if (devToolsActivePortTimer) {
      clearInterval(devToolsActivePortTimer);
      devToolsActivePortTimer = undefined;
    }
    if (driverProcess && driverProcess.exitCode === null) {
      driverProcess.kill();
    }
  },
};
