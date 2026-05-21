/**
 * Data table. Renders a fixed column list with header + body slots.
 *
 * Kept intentionally minimal -- virtualization, sorting and filter chips are
 * added in T8 when the document browser needs them.
 */
import type { KeyboardEvent, ReactNode } from 'react';

import './Table.css';

export interface TableColumn<T> {
  readonly key: string;
  readonly header: ReactNode;
  readonly render: (row: T) => ReactNode;
  readonly width?: string;
}

export interface TableProps<T> {
  readonly columns: ReadonlyArray<TableColumn<T>>;
  readonly rows: ReadonlyArray<T>;
  readonly rowKey: (row: T, index: number) => string;
  readonly emptyState?: ReactNode;
  /** When provided, rows become keyboard-activatable buttons. */
  readonly onRowClick?: (row: T, index: number) => void;
  /** Stable ``data-testid`` per row. Useful for E2E selectors. */
  readonly rowTestId?: (row: T, index: number) => string | undefined;
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  emptyState,
  onRowClick,
  rowTestId,
}: TableProps<T>): JSX.Element {
  const interactive = typeof onRowClick === 'function';
  return (
    <div className="zv-table-wrapper">
      <table className="zv-table" role="table">
        <thead>
          <tr>
            {columns.map((col) => (
              <th key={col.key} style={col.width ? { width: col.width } : undefined}>
                {col.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="zv-table__empty" colSpan={columns.length}>
                {emptyState ?? '—'}
              </td>
            </tr>
          ) : (
            rows.map((row, index) => {
              const onKeyDown = interactive
                ? (event: KeyboardEvent<HTMLTableRowElement>) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      onRowClick?.(row, index);
                    }
                  }
                : undefined;
              return (
                <tr
                  key={rowKey(row, index)}
                  className={interactive ? 'zv-table__row--interactive' : undefined}
                  role={interactive ? 'button' : undefined}
                  tabIndex={interactive ? 0 : undefined}
                  onClick={interactive ? () => onRowClick?.(row, index) : undefined}
                  onKeyDown={onKeyDown}
                  data-testid={rowTestId?.(row, index)}
                >
                  {columns.map((col) => (
                    <td key={col.key}>{col.render(row)}</td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
