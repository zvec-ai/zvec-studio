/**
 * Open Collection dialog (T6).
 *
 * Prompts for a local path and invokes ``POST /collections:open``.
 */
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Button, Dialog, DirectoryInput } from '@/components/ui';
import { useToast } from '@/components/ui/toast-context';
import { ApiError } from '@/lib/api-client';
import { useOpenCollection } from '@/features/collections';

export interface OpenCollectionDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

export function OpenCollectionDialog({ open, onClose }: OpenCollectionDialogProps): JSX.Element {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const toast = useToast();
  const mutation = useOpenCollection();

  const [path, setPath] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  async function submit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!path.trim()) {
      setError(t('pages.collections.create.errors.pathRequired'));
      return;
    }
    setError(undefined);
    try {
      const result = await mutation.mutateAsync({ path });
      const collectionName = result.name;
      setPath('');
      onClose();
      navigate(`/collections/${encodeURIComponent(collectionName)}`);
    } catch (err) {
      const title =
        err instanceof ApiError
          ? t(err.error.messageKey, { defaultValue: err.error.message })
          : t('errors.unknown');
      toast.push({ title, severity: 'error' });
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        setPath('');
        setError(undefined);
        onClose();
      }}
      title={t('pages.collections.open.title')}
      ariaLabel={t('pages.collections.open.title')}
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              setPath('');
              setError(undefined);
              onClose();
            }}
          >
            {t('actions.cancel')}
          </Button>
          <Button
            variant="primary"
            type="submit"
            form="zv-open-collection-form"
            loading={mutation.isPending}
            data-testid="zv-open-submit"
          >
            {mutation.isPending ? t('pages.collections.open.submitting') : t('actions.open')}
          </Button>
        </>
      }
    >
      <form id="zv-open-collection-form" onSubmit={(e) => void submit(e)} noValidate>
        <DirectoryInput
          label={t('pages.collections.open.path')}
          value={path}
          onChange={(next) => {
            setPath(next);
            if (error && next.trim()) setError(undefined);
          }}
          helperText={t('pages.collections.open.pathHelp')}
          errorText={error}
          browseLabel={t('actions.browse')}
          placeholder={t('pages.collections.open.pathPlaceholder')}
          data-testid="zv-open-path"
          required
        />
      </form>
    </Dialog>
  );
}
