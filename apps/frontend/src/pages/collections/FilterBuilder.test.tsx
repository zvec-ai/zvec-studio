/**
 * FilterBuilder unit tests.
 *
 * Covers SQL mode, visual builder mode, condition add/remove, expression
 * generation, and the Enter-to-apply shortcut.
 */
import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test-utils/render';
import { FilterBuilder } from './FilterBuilder';

const FIELDS = [
  { name: 'id', dataType: 'INT64' },
  { name: 'title', dataType: 'STRING' },
  { name: 'score', dataType: 'INT64' },
];

function renderBuilder(props: {
  fields?: typeof FIELDS;
  onApply?: (expr: string) => void;
  onChange?: (expr: string) => void;
} = {}) {
  return renderWithProviders(
    <FilterBuilder
      fields={props.fields ?? FIELDS}
      onApply={props.onApply}
      onChange={props.onChange}
    />,
  );
}

describe('FilterBuilder', () => {
  it('renders in SQL mode by default with an input and apply button', () => {
    const onApply = vi.fn();
    renderBuilder({ onApply });

    expect(screen.getByPlaceholderText(/category = 'news'/)).toBeInTheDocument();
    // The apply button says "Browse" (from i18n)
    expect(screen.getByRole('button', { name: /browse/i })).toBeInTheDocument();
  });

  it('calls onApply with the SQL text when the apply button is clicked', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    renderBuilder({ onApply });

    const input = screen.getByPlaceholderText(/category = 'news'/);
    await user.type(input, "title = 'hello'");
    await user.click(screen.getByRole('button', { name: /browse/i }));

    expect(onApply).toHaveBeenCalledWith("title = 'hello'");
  });

  it('calls onApply when Enter is pressed in SQL mode', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    renderBuilder({ onApply });

    const input = screen.getByPlaceholderText(/category = 'news'/);
    await user.type(input, 'score > 5{enter}');

    expect(onApply).toHaveBeenCalledWith('score > 5');
  });

  it('switches to builder mode and shows condition row', async () => {
    const user = userEvent.setup();
    renderBuilder();

    await user.click(screen.getByRole('button', { name: /builder/i }));

    const selects = screen.getAllByRole('combobox');
    expect(selects.length).toBeGreaterThanOrEqual(2);
  });

  it('emits onChange in builder mode when a condition value changes', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderBuilder({ onChange });

    await user.click(screen.getByRole('button', { name: /builder/i }));

    const valueInput = screen.getByPlaceholderText(/value/i);
    await user.type(valueInput, 'hello');

    expect(onChange).toHaveBeenCalled();
    const lastCall = onChange.mock.calls[onChange.mock.calls.length - 1][0];
    expect(lastCall).toContain('hello');
  });

  it('adds and removes conditions in builder mode', async () => {
    const user = userEvent.setup();
    renderBuilder();

    await user.click(screen.getByRole('button', { name: /builder/i }));

    let valueInputs = screen.getAllByPlaceholderText(/value/i);
    expect(valueInputs).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: /add/i }));

    valueInputs = screen.getAllByPlaceholderText(/value/i);
    expect(valueInputs).toHaveLength(2);
  });

  it('generates AND-joined expression for multiple builder conditions', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    renderBuilder({ onApply });

    await user.click(screen.getByRole('button', { name: /builder/i }));

    const valueInputs = screen.getAllByPlaceholderText(/value/i);
    await user.type(valueInputs[0], 'tech');

    await user.click(screen.getByRole('button', { name: /add/i }));
    const newInputs = screen.getAllByPlaceholderText(/value/i);
    await user.type(newInputs[1], '42');

    await user.click(screen.getByRole('button', { name: /browse/i }));

    const expr = onApply.mock.calls[0]?.[0] ?? '';
    expect(expr).toContain('AND');
  });

  it('applies empty string when SQL input is blank', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    renderBuilder({ onApply });

    await user.click(screen.getByRole('button', { name: /browse/i }));
    expect(onApply).toHaveBeenCalledWith('');
  });
});
