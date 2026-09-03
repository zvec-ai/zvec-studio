/**
 * Helpers for the Import Collection dialog.
 */

/**
 * Default target directory for a snapshot: next to the snapshot file, named
 * after the override name (when given) or the file itself minus its
 * ``.tar.gz`` / ``.tgz`` suffix. The backend still requires that the path
 * does not exist yet, so the suggestion can never silently overwrite data.
 */
export function suggestImportTarget(snapshotPath: string, name?: string): string {
  const normalized = snapshotPath.trim().replace(/\\/g, '/');
  if (!normalized) return '';
  const slash = normalized.lastIndexOf('/');
  const dir = slash > 0 ? normalized.slice(0, slash) : '';
  let base = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  base = base.replace(/\.tar\.gz$/i, '').replace(/\.tgz$/i, '');
  const leaf = name?.trim() || base;
  if (!leaf) return dir;
  return dir ? `${dir}/${leaf}` : leaf;
}
