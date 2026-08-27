/**
 * Import Collection dialog (snapshot import).
 *
 * Collection-level lifecycle operation (a sibling of Create/Open, reached
 * from the sidebar): imports a whole collection from a snapshot package
 * (``.tar.gz``) — the embedded manifest supplies the schema, the target
 * directory gives the new collection its home, and the data loads in the
 * same pass (``POST /collections:import``).
 */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Button, Dialog, DirectoryInput, FilePickerDialog, Input } from '@/components/ui';
import { useToast } from '@/components/ui/toast-context';
import { ApiError } from '@/lib/api-client';
import { useImportCollection } from '@/features/collections';

import { suggestImportTarget } from './import-utils';

const SNAPSHOT_EXTENSIONS = '.tar.gz,.tgz';

export interface ImportCollectionDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function ImportCollectionDialog({
  open,
  onClose,
}: ImportCollectionDialogProps): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const mutation = useImportCollection();

  const [snapshotPath, setSnapshotPath] = useState('');
  const [targetPath, setTargetPath] = useState('');
  const [name, setName] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  // Last auto-suggestion: the target follows the suggestion until the user
  // edits it by hand, then stays put.
  const lastSuggestion = useRef('');

  useEffect(() => {
    const suggestion = suggestImportTarget(snapshotPath, name);
    if (targetPath === '' || targetPath === lastSuggestion.current) {
      setTargetPath(suggestion);
    }
    lastSuggestion.current = suggestion;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshotPath, name]);

  function reset(): void {
    setSnapshotPath('');
    setTargetPath('');
    setName('');
    setError(undefined);
    lastSuggestion.current = '';
  }

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!snapshotPath.trim() || !targetPath.trim()) {
      setError(t('pages.collections.importCollection.errors.required'));
      return;
    }
    setError(undefined);
    try {
      const result = await mutation.mutateAsync({
        source: { kind: 'localPath', path: snapshotPath.trim() },
        targetPath: targetPath.trim(),
        ...(name.trim() ? { name: name.trim() } : {}),
      });
      const { collection, report } = result;
      reset();
      onClose();
      // Row-level failures ride in the 201 body (partial-success contract);
      // surface them as a warning instead of a blanket success.
      if (report.aborted || report.failed > 0) {
        toast.push({
          severity: 'warning',
          title: t('pages.collections.importCollection.partialTitle'),
          description: t('pages.collections.importCollection.partialBody', {
            name: collection.name,
            imported: report.imported,
            failed: report.failed,
          }),
        });
      } else {
        toast.push({
          severity: 'success',
          title: t('pages.collections.importCollection.successTitle'),
          description: t('pages.collections.importCollection.successBody', {
            name: collection.name,
            count: report.imported,
          }),
        });
      }
      navigate(`/collections/${encodeURIComponent(collection.name)}`);
    } catch (err) {
      const title =
        err instanceof ApiError
          ? t(err.error.messageKey, { defaultValue: err.error.message })
          : t('errors.unknown');
      const description = err instanceof ApiError ? err.error.message : undefined;
      toast.push({ title, description, severity: 'error' });
    }
  }

  return (
    <>
      <Dialog
        open={open}
        onClose={() => {
          reset();
          onClose();
        }}
        title={t('pages.collections.importCollection.title')}
        ariaLabel={t('pages.collections.importCollection.title')}
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                reset();
                onClose();
              }}
            >
              {t('actions.cancel')}
            </Button>
            <Button
              variant="primary"
              type="submit"
              form="zv-import-collection-form"
              loading={mutation.isPending}
              disabled={!snapshotPath.trim() || !targetPath.trim()}
              data-testid="zv-collection-import-submit"
            >
              {mutation.isPending
                ? t('pages.collections.importCollection.submitting')
                : t('pages.collections.importCollection.submit')}
            </Button>
          </>
        }
      >
        <form id="zv-import-collection-form" onSubmit={(e) => void submit(e)} noValidate>
          <Input
            label={t('pages.collections.importCollection.fileLabel')}
            value={snapshotPath}
            onChange={(e) => {
              setSnapshotPath(e.target.value);
              if (error) setError(undefined);
            }}
            helperText={t('pages.collections.importCollection.fileHelp')}
            placeholder="/path/to/collection.tar.gz"
            data-testid="zv-collection-import-path"
          />
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => setPickerOpen(true)}
            data-testid="zv-collection-import-browse"
            style={{ marginTop: 8 }}
          >
            {t('pages.collections.importCollection.browse')}
          </Button>

          <div style={{ marginTop: 16 }}>
            <DirectoryInput
              label={t('pages.collections.importCollection.targetLabel')}
              value={targetPath}
              onChange={(next) => {
                setTargetPath(next);
                if (error && next.trim()) setError(undefined);
              }}
              helperText={t('pages.collections.importCollection.targetHelp')}
              browseLabel={t('actions.browse')}
              placeholder="/path/to/new-collection"
              data-testid="zv-collection-import-target"
              required
            />
          </div>

          <div style={{ marginTop: 16 }}>
            <Input
              label={t('pages.collections.importCollection.nameLabel')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              helperText={t('pages.collections.importCollection.nameHelp')}
              placeholder={t('pages.collections.importCollection.namePlaceholder')}
              data-testid="zv-collection-import-name"
            />
          </div>

          {error ? (
            <p className="zv-form-error" role="alert" style={{ marginTop: 12 }}>
              {error}
            </p>
          ) : null}
        </form>
      </Dialog>

      <FilePickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(picked) => {
          setSnapshotPath(picked);
          setPickerOpen(false);
        }}
        extensions={SNAPSHOT_EXTENSIONS}
        title={t('pages.collections.importCollection.pickerTitle')}
      />
    </>
  );
}
