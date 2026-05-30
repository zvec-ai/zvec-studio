import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test-utils/render';

import { SpotlightTour, type TourStep } from './SpotlightTour';

function addTarget(name: string, rect = { top: 40, left: 60, width: 120, height: 32 }): HTMLElement {
  const target = document.createElement('div');
  target.setAttribute('data-tour', name);
  target.textContent = name;
  target.getBoundingClientRect = () => ({
    ...rect,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => undefined,
  });
  document.body.appendChild(target);
  return target;
}

function steps(): TourStep[] {
  return [
    {
      target: '[data-tour="one"]',
      titleKey: 'nav.collections',
      bodyKey: 'nav.collections',
      placement: 'right',
    },
    {
      target: '[data-tour="missing"]',
      titleKey: 'nav.collections',
      bodyKey: 'nav.collections',
      optional: true,
    },
    {
      target: '[data-tour="two"]',
      titleKey: 'nav.embeddings',
      bodyKey: 'nav.embeddings',
      placement: 'bottom',
      overlay: <div data-testid="tour-overlay">Overlay</div>,
    },
  ];
}

describe('SpotlightTour', () => {
  afterEach(() => {
    document.querySelectorAll('[data-tour="one"], [data-tour="two"]').forEach((el) => el.remove());
  });

  it('filters missing optional steps and moves next/previous through visible steps', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    addTarget('one');
    addTarget('two', { top: 120, left: 160, width: 180, height: 40 });

    renderWithProviders(<SpotlightTour open steps={steps()} onDismiss={onDismiss} />);

    expect(await screen.findByTestId('zv-tour')).toBeInTheDocument();
    expect(screen.getByText('Guide · 1/2')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Collections' })).toBeInTheDocument();

    await user.click(screen.getByTestId('zv-tour-next'));
    expect(screen.getByText('Guide · 2/2')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Embeddings' })).toBeInTheDocument();
    expect(screen.getByTestId('tour-overlay')).toBeInTheDocument();

    await user.click(screen.getByTestId('zv-tour-prev'));
    expect(screen.getByText('Guide · 1/2')).toBeInTheDocument();
  });

  it('dismisses when skipped or when the final step finishes', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    addTarget('one');
    addTarget('two');

    renderWithProviders(<SpotlightTour open steps={steps()} onDismiss={onDismiss} />);

    await screen.findByTestId('zv-tour');
    await user.click(screen.getByTestId('zv-tour-skip'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('uses a fallback target when the primary selector is unavailable', async () => {
    const user = userEvent.setup();
    const onDismiss = vi.fn();
    addTarget('one');

    renderWithProviders(
      <SpotlightTour
        open
        steps={[
          {
            target: '[data-tour="missing"]',
            fallbackTarget: '[data-tour="one"]',
            titleKey: 'nav.collections',
            bodyKey: 'nav.collections',
          },
        ]}
        onDismiss={onDismiss}
      />,
    );

    expect(await screen.findByRole('heading', { name: 'Collections' })).toBeInTheDocument();
    await user.click(screen.getByTestId('zv-tour-next'));
    await waitFor(() => {
      expect(onDismiss).toHaveBeenCalledTimes(1);
    });
  });
});
