import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test-utils/render';
import {
  Button,
  CloseButton,
  Dialog,
  Input,
  LoadingOverlay,
  Select,
  Spinner,
  Table,
  Tabs,
} from '.';

describe('UI controls', () => {
  it('keeps loading buttons disabled and exposes busy state', async () => {
    const user = userEvent.setup();
    const onClick = vi.fn();
    renderWithProviders(
      <Button loading onClick={onClick}>
        Save
      </Button>,
    );

    const button = screen.getByRole('button', { name: /save/i });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    await user.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('wires input and select labels, helper text, and error state', () => {
    renderWithProviders(
      <>
        <Input label="Name" value="demo" onChange={() => undefined} helperText="Helpful text" />
        <Select
          label="Mode"
          value="raw"
          onChange={() => undefined}
          errorText="Pick a valid mode"
          options={[
            { value: 'raw', label: 'Raw' },
            { value: 'text', label: 'Text' },
          ]}
        />
      </>,
    );

    expect(screen.getByLabelText('Name')).toHaveAccessibleDescription('Helpful text');
    expect(screen.getByLabelText('Mode')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('alert')).toHaveTextContent('Pick a valid mode');
  });

  it('renders dialog content and handles native cancel events', async () => {
    const onClose = vi.fn();
    renderWithProviders(
      <Dialog
        open
        title="Confirm action"
        onClose={onClose}
        footer={<Button>Confirm</Button>}
      >
        Dialog body
      </Dialog>,
    );

    const dialog = await screen.findByRole('dialog', { name: /confirm action/i });
    expect(screen.getByText('Dialog body')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /confirm/i })).toBeInTheDocument();

    fireEvent(dialog, new Event('cancel', { bubbles: false, cancelable: true }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('activates interactive table rows by click, Enter, and Space', async () => {
    const user = userEvent.setup();
    const onRowClick = vi.fn();
    renderWithProviders(
      <Table
        columns={[
          { key: 'name', header: 'Name', render: (row: { name: string }) => row.name },
        ]}
        rows={[{ name: 'alpha' }]}
        rowKey={(row) => row.name}
        rowTestId={(row) => `row-${row.name}`}
        onRowClick={onRowClick}
      />,
    );

    const row = screen.getByTestId('row-alpha');
    await user.click(row);
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });

    expect(onRowClick).toHaveBeenCalledTimes(3);
    expect(onRowClick).toHaveBeenLastCalledWith({ name: 'alpha' }, 0);
  });

  it('renders empty table state and controlled tabs', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    renderWithProviders(
      <>
        <Table
          columns={[{ key: 'name', header: 'Name', render: (row: { name: string }) => row.name }]}
          rows={[]}
          rowKey={(row) => row.name}
          emptyState="No rows"
        />
        <Tabs
          ariaLabel="Modes"
          value="one"
          onChange={onChange}
          items={[
            { key: 'one', label: 'One' },
            { key: 'two', label: 'Two' },
            { key: 'disabled', label: 'Disabled', disabled: true },
          ]}
        >
          Active panel
        </Tabs>
      </>,
    );

    expect(screen.getByText('No rows')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'One' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('zv-tabpanel-one')).toHaveTextContent('Active panel');

    await user.click(screen.getByRole('tab', { name: 'Two' }));
    expect(onChange).toHaveBeenCalledWith('two');

    await user.click(screen.getByRole('tab', { name: 'Disabled' }));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('renders status indicators and close buttons accessibly', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    renderWithProviders(
      <>
        <Spinner size={20} ariaLabel="Working" />
        <LoadingOverlay label="Loading data" />
        <CloseButton onClick={onClose} />
      </>,
    );

    expect(screen.getByRole('status', { name: 'Working' })).toHaveStyle({ width: '20px', height: '20px' });
    expect(screen.getByText('Loading data')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /remove/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
