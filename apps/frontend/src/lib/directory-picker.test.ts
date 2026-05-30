import { describe, expect, it } from 'vitest';

import { pickDirectoryNative, supportsNativeDirectoryPicker } from './directory-picker';

describe('directory picker runtime adapter', () => {
  it('reports unsupported outside the Tauri runtime', async () => {
    expect(supportsNativeDirectoryPicker()).toBe(false);
    await expect(pickDirectoryNative()).resolves.toEqual({ kind: 'unsupported' });
  });
});
