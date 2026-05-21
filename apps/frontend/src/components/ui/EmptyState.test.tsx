import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { EmptyState } from './EmptyState';

describe('EmptyState', () => {
  it('renders title and description with the given testId', () => {
    render(
      <EmptyState
        testId="zv-test-empty"
        title="Nothing here yet"
        description="Create one to get started."
      />,
    );
    const root = screen.getByTestId('zv-test-empty');
    expect(root).toHaveTextContent('Nothing here yet');
    expect(root).toHaveTextContent('Create one to get started.');
  });

  it('renders action slot when provided', () => {
    render(
      <EmptyState
        title="Empty"
        actions={<button type="button">Create</button>}
      />,
    );
    expect(screen.getByRole('button', { name: /create/i })).toBeInTheDocument();
  });

  it('applies compact variant class', () => {
    render(<EmptyState testId="zv-compact-empty" title="Empty" compact />);
    expect(screen.getByTestId('zv-compact-empty').className).toMatch(/zv-empty-state--compact/);
  });
});
