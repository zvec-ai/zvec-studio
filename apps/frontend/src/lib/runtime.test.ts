import { afterEach, describe, expect, it, vi } from 'vitest';

import { getSidecarStatus, invokeTauri, isTauri } from './runtime';

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: { invoke: ReturnType<typeof vi.fn> };
  __TAURI__?: { invoke: ReturnType<typeof vi.fn> };
};

describe('runtime helpers', () => {
  afterEach(() => {
    const w = window as TauriWindow;
    delete w.__TAURI_INTERNALS__;
    delete w.__TAURI__;
  });

  it('isTauri returns false on the Web build (no global injected)', () => {
    expect(isTauri()).toBe(false);
  });

  it('invokeTauri resolves to null when not running inside Tauri', async () => {
    await expect(invokeTauri('sidecar_status')).resolves.toBeNull();
  });

  it('invokeTauri delegates to window.__TAURI_INTERNALS__.invoke when present', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    (window as TauriWindow).__TAURI_INTERNALS__ = { invoke };
    expect(isTauri()).toBe(true);

    const result = await invokeTauri<{ ok: boolean }>('do_thing', { foo: 1 });

    expect(invoke).toHaveBeenCalledWith('do_thing', { foo: 1 });
    expect(result).toEqual({ ok: true });
  });

  it('invokeTauri falls back to window.__TAURI__.invoke (v1 surface)', async () => {
    const invoke = vi.fn().mockResolvedValue('legacy');
    (window as TauriWindow).__TAURI__ = { invoke };
    expect(isTauri()).toBe(true);

    await expect(invokeTauri('legacy_cmd')).resolves.toBe('legacy');
    expect(invoke).toHaveBeenCalledWith('legacy_cmd', undefined);
  });

  it('getSidecarStatus translates snake_case payload into camelCase', async () => {
    const invoke = vi.fn().mockResolvedValue({
      running: true,
      pid: 4242,
      base_url: 'http://127.0.0.1:7860',
    });
    (window as TauriWindow).__TAURI_INTERNALS__ = { invoke };

    await expect(getSidecarStatus()).resolves.toEqual({
      running: true,
      pid: 4242,
      baseUrl: 'http://127.0.0.1:7860',
    });
    expect(invoke).toHaveBeenCalledWith('sidecar_status', undefined);
  });

  it('getSidecarStatus resolves to null on the Web build', async () => {
    await expect(getSidecarStatus()).resolves.toBeNull();
  });
});
