/**
 * Native directory picker (Tauri only).
 *
 * The browser's ``window.showDirectoryPicker`` only exposes the leaf name
 * (W3C File System Access spec, security model), so it cannot return a
 * usable absolute path. Web callers should instead open the in-app
 * ``DirectoryPickerDialog`` which talks to the backend ``/fs/list`` endpoint.
 */
import { invokeTauri, isTauri } from './runtime';

export type DirectoryPickResult =
  | { readonly kind: 'picked'; readonly path: string }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unsupported' };

/** Whether a native (Tauri) directory picker is available in this runtime. */
export function supportsNativeDirectoryPicker(): boolean {
  return isTauri();
}

/**
 * Invoke the Tauri native directory picker. Returns ``unsupported`` if the
 * runtime is not Tauri (e.g. plain browser).
 */
export async function pickDirectoryNative(): Promise<DirectoryPickResult> {
  if (!isTauri()) return { kind: 'unsupported' };
  try {
    const result = await invokeTauri<string | string[] | null>('plugin:dialog|open', {
      options: { directory: true, multiple: false },
    });
    if (typeof result === 'string' && result.length > 0) {
      return { kind: 'picked', path: result };
    }
    if (Array.isArray(result) && result.length > 0) {
      return { kind: 'picked', path: result[0] };
    }
    return { kind: 'cancelled' };
  } catch {
    return { kind: 'unsupported' };
  }
}
