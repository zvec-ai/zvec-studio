/**
 * Placeholder pages unit tests.
 *
 * Verifies each placeholder page renders its expected content and test IDs.
 */
import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';

import { renderWithProviders } from '@/test-utils/render';

import {
  DocumentsPlaceholder,
  SearchPlaceholder,
  NotFoundPage,
} from './Placeholders';

describe('DocumentsPlaceholder', () => {
  it('renders with the correct testId', () => {
    renderWithProviders(<DocumentsPlaceholder />);

    expect(screen.getByTestId('page-documents')).toBeInTheDocument();
    expect(screen.getByTestId('zv-page-documents-empty')).toBeInTheDocument();
  });

  it('navigates home when the CTA button is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route path="/documents" element={<DocumentsPlaceholder />} />
        <Route path="/" element={<div data-testid="home-page">Home</div>} />
      </Routes>,
      { initialEntries: ['/documents'] },
    );

    expect(screen.getByTestId('page-documents')).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /go to collections/i });
    await user.click(btn);
    expect(await screen.findByTestId('home-page')).toBeInTheDocument();
  });
});

describe('SearchPlaceholder', () => {
  it('renders with the correct testId', () => {
    renderWithProviders(<SearchPlaceholder />);

    expect(screen.getByTestId('page-search')).toBeInTheDocument();
    expect(screen.getByTestId('zv-page-search-empty')).toBeInTheDocument();
  });

  it('navigates home when the CTA button is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <Routes>
        <Route path="/search" element={<SearchPlaceholder />} />
        <Route path="/" element={<div data-testid="home-page">Home</div>} />
      </Routes>,
      { initialEntries: ['/search'] },
    );

    const btn = screen.getByRole('button', { name: /go to collections/i });
    await user.click(btn);
    expect(await screen.findByTestId('home-page')).toBeInTheDocument();
  });
});

describe('NotFoundPage', () => {
  it('renders with the correct testId', () => {
    renderWithProviders(<NotFoundPage />);

    expect(screen.getByTestId('page-not-found')).toBeInTheDocument();
    expect(screen.getByTestId('zv-not-found-card')).toBeInTheDocument();
  });

  it('has a link back to home', () => {
    renderWithProviders(<NotFoundPage />);

    const link = screen.getByRole('button', { name: /back to home/i }).closest('a');
    expect(link).toHaveAttribute('href', '/');
  });
});
