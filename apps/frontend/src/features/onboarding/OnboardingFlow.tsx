/**
 * Three-step onboarding walkthrough.
 *
 * Shown once per browser profile on first launch (see ``useOnboarding``).
 * Keeps users oriented around the three primary flows: Collections, Documents
 * and Vector search. The first step also surfaces the persisted recently-
 * opened collections list so returning users can spot their previous work.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button, CloseButton, Dialog } from '@/components/ui';
import {
  useClearRecent,
  useForgetRecent,
  useListRecent,
  type RecentCollectionItem,
} from '@/features/collections';

import './OnboardingFlow.css';

export interface OnboardingFlowProps {
  readonly open: boolean;
  readonly onDismiss: () => void;
}

const STEP_COUNT = 5;

export function OnboardingFlow({ open, onDismiss }: OnboardingFlowProps): JSX.Element {
  const { t } = useTranslation();
  const [step, setStep] = useState<number>(0);

  function handleNext(): void {
    if (step + 1 >= STEP_COUNT) {
      setStep(0);
      onDismiss();
      return;
    }
    setStep((s) => s + 1);
  }

  function handlePrev(): void {
    setStep((s) => Math.max(0, s - 1));
  }

  function handleSkip(): void {
    setStep(0);
    onDismiss();
  }

  const stepKey = `pages.onboarding.steps.${step}`;
  const isLast = step + 1 === STEP_COUNT;

  return (
    <Dialog
      open={open}
      onClose={handleSkip}
      title={t('pages.onboarding.title')}
      footer={
        <div className="zv-onboarding__footer">
          <Button variant="ghost" size="sm" onClick={handleSkip} data-testid="zv-onboarding-skip">
            {t('pages.onboarding.skip')}
          </Button>
          <div className="zv-onboarding__nav">
            {step > 0 && (
              <Button
                variant="secondary"
                size="sm"
                onClick={handlePrev}
                data-testid="zv-onboarding-prev"
              >
                {t('pages.onboarding.prev')}
              </Button>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={handleNext}
              data-testid="zv-onboarding-next"
            >
              {isLast ? t('pages.onboarding.finish') : t('pages.onboarding.next')}
            </Button>
          </div>
        </div>
      }
    >
      {open && (
        <div className="zv-onboarding" data-testid="zv-onboarding">
          <ol className="zv-onboarding__stepper" aria-label={t('pages.onboarding.stepperAria')}>
            {Array.from({ length: STEP_COUNT }).map((_, index) => (
              <li
                key={index}
                className={[
                  'zv-onboarding__step-dot',
                  index === step ? 'zv-onboarding__step-dot--active' : '',
                  index < step ? 'zv-onboarding__step-dot--done' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
                aria-current={index === step ? 'step' : undefined}
              />
            ))}
          </ol>
          <h3 className="zv-onboarding__title" data-testid={`zv-onboarding-step-${step}`}>
            {t(`${stepKey}.title`)}
          </h3>
          <p className="zv-onboarding__body">{t(`${stepKey}.body`)}</p>
          {step === 0 && <RecentSection />}
        </div>
      )}
    </Dialog>
  );
}

/** Persisted recently-opened collections, shown on the first onboarding step. */
function RecentSection(): JSX.Element | null {
  const { t } = useTranslation();
  const recent = useListRecent();
  const forget = useForgetRecent();
  const clear = useClearRecent();

  const items = recent.data?.items ?? [];
  if (recent.isLoading) {
    return (
      <p className="zv-onboarding__recent-empty" data-testid="zv-onboarding-recent-loading">
        {t('pages.onboarding.recent.loading')}
      </p>
    );
  }
  if (items.length === 0) {
    return (
      <p className="zv-onboarding__recent-empty" data-testid="zv-onboarding-recent-empty">
        {t('pages.onboarding.recent.empty')}
      </p>
    );
  }
  return (
    <section
      className="zv-onboarding__recent"
      aria-label={t('pages.onboarding.recent.aria')}
      data-testid="zv-onboarding-recent"
    >
      <header className="zv-onboarding__recent-header">
        <h4 className="zv-onboarding__recent-title">
          {t('pages.onboarding.recent.title')}
        </h4>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => clear.mutate()}
          disabled={clear.isPending}
          data-testid="zv-onboarding-recent-clear"
        >
          {t('pages.onboarding.recent.clearAll')}
        </Button>
      </header>
      <ul className="zv-onboarding__recent-list">
        {items.map((item) => (
          <RecentItem
            key={item.path}
            item={item}
            onForget={() => forget.mutate({ path: item.path })}
            disabled={forget.isPending}
          />
        ))}
      </ul>
    </section>
  );
}

interface RecentItemProps {
  readonly item: RecentCollectionItem;
  readonly onForget: () => void;
  readonly disabled: boolean;
}

function RecentItem({ item, onForget, disabled }: RecentItemProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <li
      className="zv-onboarding__recent-item"
      data-testid={`zv-onboarding-recent-item-${item.path}`}
    >
      <div className="zv-onboarding__recent-meta">
        <code className="zv-onboarding__recent-path">{item.path}</code>
        <span className="zv-onboarding__recent-time">
          {new Date(item.lastOpenedAt).toLocaleString()}
        </span>
      </div>
      <CloseButton
        onClick={onForget}
        disabled={disabled}
        aria-label={t('pages.onboarding.recent.forgetAria', { path: item.path })}
        data-testid={`zv-onboarding-recent-forget-${item.path}`}
      />
    </li>
  );
}
