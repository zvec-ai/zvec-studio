/**
 * Tauri runtime detection.
 *
 * The desktop shell injects a small global object on `window` (Tauri v2 uses
 * `__TAURI_INTERNALS__`, older Tauri v1 surface used `__TAURI__`). The Web
 * build never has this, so feature pages can use `isTauri()` to gate native
 * capabilities (file dialogs, window decorations, OS notifications, ...).
 *
 * `invokeTauri()` is a thin wrapper around the global invoke channel exposed
 * by the desktop shell when `withGlobalTauri: true` is set in
 * `tauri.conf.json`. We deliberately do **not** depend on `@tauri-apps/api`
 * here so that the Web build does not pull a native-only package.
 */

type TauriV2Globals = {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
};

type TauriWindow = {
  __TAURI_INTERNALS__?: TauriV2Globals;
  __TAURI__?: { invoke: TauriV2Globals['invoke'] };
};

function getTauri(): TauriV2Globals | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as TauriWindow;
  if (w.__TAURI_INTERNALS__?.invoke) return w.__TAURI_INTERNALS__;
  if (w.__TAURI__?.invoke) return { invoke: w.__TAURI__.invoke };
  return null;
}

/** Whether the SPA is running inside the Tauri desktop shell. */
export function isTauri(): boolean {
  return getTauri() !== null;
}

/**
 * Invoke a Tauri command from the SPA. Returns `null` on Web so callers can
 * branch without `isTauri()` boilerplate at every call site.
 */
export async function invokeTauri<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  const tauri = getTauri();
  if (!tauri) return null;
  return tauri.invoke<T>(cmd, args);
}

/**
 * Sidecar status surfaced by the Rust shell (mirrors `commands.rs::SidecarStatus`).
 * Exposed so dev tools / future status indicators can display it.
 */
export type SidecarStatus = {
  running: boolean;
  pid: number | null;
  baseUrl: string;
};

export async function getSidecarStatus(): Promise<SidecarStatus | null> {
  const raw = await invokeTauri<{ running: boolean; pid: number | null; base_url: string }>(
    'sidecar_status',
  );
  if (!raw) return null;
  return { running: raw.running, pid: raw.pid, baseUrl: raw.base_url };
}
