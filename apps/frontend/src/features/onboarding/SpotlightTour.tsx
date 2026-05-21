import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';

import './SpotlightTour.css';

export interface TourStep {
  readonly target: string;
  readonly fallbackTarget?: string;
  readonly titleKey: string;
  readonly bodyKey: string;
  readonly placement?: 'right' | 'left' | 'bottom' | 'top';
  readonly optional?: boolean;
  readonly overlay?: React.ReactNode;
}

export interface SpotlightTourProps {
  readonly open: boolean;
  readonly steps: readonly TourStep[];
  readonly onDismiss: () => void;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const PAD = 8;
const TOOLTIP_GAP = 12;
const TOOLTIP_WIDTH = 320;
const TOOLTIP_HEIGHT_EST = 200;
const VIEWPORT_MARGIN = 16;

function getTargetRect(selector: string): Rect | null {
  const el = document.querySelector(selector);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

function clamp(pos: { top: number; left: number }): { top: number; left: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    top: Math.max(VIEWPORT_MARGIN, Math.min(pos.top, vh - TOOLTIP_HEIGHT_EST - VIEWPORT_MARGIN)),
    left: Math.max(VIEWPORT_MARGIN, Math.min(pos.left, vw - TOOLTIP_WIDTH - VIEWPORT_MARGIN)),
  };
}

function computeTooltipPos(
  rect: Rect,
  placement: 'right' | 'left' | 'bottom' | 'top',
): { top: number; left: number } {
  let pos: { top: number; left: number };
  switch (placement) {
    case 'right':
      pos = {
        top: rect.top - PAD,
        left: rect.left + rect.width + PAD + TOOLTIP_GAP,
      };
      break;
    case 'left':
      pos = {
        top: rect.top - PAD,
        left: rect.left - PAD - TOOLTIP_GAP - TOOLTIP_WIDTH,
      };
      break;
    case 'bottom':
      pos = {
        top: rect.top + rect.height + PAD + TOOLTIP_GAP,
        left: rect.left - PAD,
      };
      break;
    case 'top':
      pos = {
        top: rect.top - PAD - TOOLTIP_GAP - TOOLTIP_HEIGHT_EST,
        left: rect.left - PAD,
      };
      break;
  }
  return clamp(pos);
}

function getVisibleSteps(steps: readonly TourStep[]): TourStep[] {
  return steps.filter((s) => !s.optional || document.querySelector(s.target));
}

export function SpotlightTour({ open, steps: allSteps, onDismiss }: SpotlightTourProps): JSX.Element | null {
  const { t } = useTranslation();
  const [step, setStep] = useState(0);
  const [targetRect, setTargetRect] = useState<Rect | null>(null);
  const [steps, setSteps] = useState<TourStep[]>(() => getVisibleSteps(allSteps));

  useEffect(() => {
    if (open) setSteps(getVisibleSteps(allSteps));
  }, [open, allSteps]);

  const currentStep = steps[step];

  const measure = useCallback(() => {
    if (!open || !currentStep) return;
    const rect = getTargetRect(currentStep.target)
      ?? (currentStep.fallbackTarget ? getTargetRect(currentStep.fallbackTarget) : null);
    setTargetRect(rect);
  }, [open, currentStep]);

  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    if (!open) return;
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [open, measure]);

  useEffect(() => {
    if (!open) {
      setStep(0);
    }
  }, [open]);

  if (!open || !currentStep) return null;

  const placement = currentStep.placement ?? 'right';

  function handleNext() {
    if (step + 1 >= steps.length) {
      setStep(0);
      onDismiss();
    } else {
      setStep((s) => s + 1);
    }
  }

  function handlePrev() {
    setStep((s) => Math.max(0, s - 1));
  }

  function handleSkip() {
    setStep(0);
    onDismiss();
  }

  const isLast = step + 1 === steps.length;

  const spotlightStyle: React.CSSProperties = targetRect
    ? {
        top: targetRect.top - PAD,
        left: targetRect.left - PAD,
        width: targetRect.width + PAD * 2,
        height: targetRect.height + PAD * 2,
      }
    : { top: 0, left: 0, width: 0, height: 0 };

  const tooltipPos = targetRect
    ? computeTooltipPos(targetRect, placement)
    : { top: window.innerHeight / 2 - 100, left: window.innerWidth / 2 - TOOLTIP_WIDTH / 2 };

  return createPortal(
    <div className="zv-tour-overlay" data-testid="zv-tour">
      {currentStep.overlay}
      <div className="zv-tour-backdrop" onClick={handleSkip} />
      {targetRect && <div className="zv-tour-spotlight" style={spotlightStyle} />}
      <div
        className={`zv-tour-tooltip zv-tour-tooltip--${placement}`}
        style={{ top: tooltipPos.top, left: tooltipPos.left }}
      >
        <div className="zv-tour-tooltip__arrow" />
        <div className="zv-tour-tooltip__step">
          {t('sidebar.guide')} · {step + 1}/{steps.length}
        </div>
        <h3 className="zv-tour-tooltip__title">{t(currentStep.titleKey)}</h3>
        <p className="zv-tour-tooltip__body">{t(currentStep.bodyKey)}</p>
        <div className="zv-tour-tooltip__footer">
          <div className="zv-tour-tooltip__dots">
            {steps.map((_, i) => (
              <div
                key={i}
                className={[
                  'zv-tour-tooltip__dot',
                  i === step ? 'zv-tour-tooltip__dot--active' : '',
                  i < step ? 'zv-tour-tooltip__dot--done' : '',
                ]
                  .filter(Boolean)
                  .join(' ')}
              />
            ))}
          </div>
          <div className="zv-tour-tooltip__actions">
            <button
              type="button"
              className="zv-tour-tooltip__skip"
              onClick={handleSkip}
              data-testid="zv-tour-skip"
            >
              {t('pages.onboarding.skip')}
            </button>
            {step > 0 && (
              <button
                type="button"
                className="zv-tour-tooltip__btn zv-tour-tooltip__btn--secondary"
                onClick={handlePrev}
                data-testid="zv-tour-prev"
              >
                {t('pages.onboarding.prev')}
              </button>
            )}
            <button
              type="button"
              className="zv-tour-tooltip__btn"
              onClick={handleNext}
              data-testid="zv-tour-next"
            >
              {isLast ? t('pages.onboarding.finish') : t('pages.onboarding.next')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
