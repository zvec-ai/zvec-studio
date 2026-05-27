import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { App } from './App';

describe('App (integration)', () => {
  it('renders the welcome page at /', async () => {
    render(<App initialEntries={['/']} />);
    expect(await screen.findByTestId('app-shell')).toBeInTheDocument();
    expect(screen.getAllByText(/Welcome to Zvec Studio/).length).toBeGreaterThanOrEqual(1);
  });

  it('renders the app shell with sidebar', async () => {
    render(<App initialEntries={['/']} />);
    expect(await screen.findByTestId('app-shell')).toBeInTheDocument();
    expect(screen.getByAltText('Zvec Studio')).toBeInTheDocument();
  });

  it('renders the not-found page for unknown paths', async () => {
    render(<App initialEntries={['/does-not-exist']} />);
    expect(await screen.findByTestId('page-not-found')).toBeInTheDocument();
  });
});
