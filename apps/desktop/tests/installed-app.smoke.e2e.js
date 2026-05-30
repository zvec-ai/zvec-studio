import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

function byTestId(id) {
  return $(`[data-testid="${id}"]`);
}

async function tauriInvoke(command) {
  return browser.execute(async (cmd) => {
    const w = window;
    const invoke = w.__TAURI_INTERNALS__?.invoke ?? w.__TAURI__?.invoke;
    if (!invoke) return null;
    return invoke(cmd);
  }, command);
}

async function waitForActiveTab(name) {
  const tab = await byTestId(`zv-detail-tab-${name}`);
  await tab.waitForDisplayed({ timeout: 30000 });
  await tab.click();
  await browser.waitUntil(
    async () => (await tab.getAttribute('class')).includes('zv-detail-tab--active'),
    {
      timeout: 30000,
      timeoutMsg: `tab ${name} did not become active`,
    },
  );
}

describe('installed desktop app', () => {
  it('starts sidecar and supports the core collection UI path', async () => {
    await byTestId('app-shell').waitForDisplayed({ timeout: 60000 });

    let status = null;
    await browser.waitUntil(
      async () => {
        status = await tauriInvoke('sidecar_status');
        return Boolean(status?.running);
      },
      {
        timeout: 60000,
        timeoutMsg: 'sidecar_status did not report a running sidecar',
      },
    );
    assert.equal(status.running, true);
    assert.match(status.base_url, /^http:\/\/127\.0\.0\.1:\d+$/);

    const suffix = Date.now().toString(36);
    const collectionName = `uitest${suffix}`;
    const collectionPath = path.join(os.tmpdir(), `zvec-${collectionName}`);

    const createButton = await byTestId('zv-welcome-create');
    await createButton.waitForClickable({ timeout: 30000 });
    await createButton.click();

    await byTestId('zv-create-name').setValue(collectionName);
    await byTestId('zv-create-path').setValue(collectionPath);
    await byTestId('zv-create-submit').click();

    await byTestId('zv-detail-tab-overview').waitForDisplayed({ timeout: 60000 });
    const pathname = await browser.execute(() => window.location.pathname);
    assert.equal(pathname, `/collections/${collectionName}`);

    for (const tab of ['overview', 'browse', 'query', 'write']) {
      await waitForActiveTab(tab);
    }
  });
});
