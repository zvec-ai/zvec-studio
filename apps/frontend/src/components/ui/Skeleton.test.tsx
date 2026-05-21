import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Skeleton } from './Skeleton';

describe('Skeleton', () => {
  it('renders the default text variant with aria-busy', () => {
    render(<Skeleton testId="zv-sk-text" />);
    const el = screen.getByTestId('zv-sk-text');
    expect(el.getAttribute('aria-busy')).toBe('true');
    expect(el.className).toMatch(/zv-skeleton--text/);
  });

  it('renders the block variant with custom size', () => {
    render(<Skeleton variant="block" width={120} height={60} testId="zv-sk-block" />);
    const el = screen.getByTestId('zv-sk-block');
    expect(el.className).toMatch(/zv-skeleton--block/);
    expect(el.style.width).toBe('120px');
    expect(el.style.height).toBe('60px');
  });

  it('renders the table-rows variant with the requested number of rows/columns', () => {
    render(
      <Skeleton variant="table-rows" rows={4} columns={3} testId="zv-sk-table" />,
    );
    const root = screen.getByTestId('zv-sk-table');
    expect(root.className).toMatch(/zv-skeleton--table/);
    expect(root.querySelectorAll('.zv-skeleton__row')).toHaveLength(4);
    expect(root.querySelectorAll('.zv-skeleton__cell')).toHaveLength(12);
  });
});
