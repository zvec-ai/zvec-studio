/**
 * Minimal controlled Tabs primitive.
 *
 * Renders a ``role="tablist"`` of buttons and exposes a single active panel
 * via ``children``. Pages control which tab is active through ``value`` so the
 * active key can be mirrored to the URL or query-string later without
 * reworking the component.
 */
import type { ReactNode } from 'react';

import './Tabs.css';

export interface TabItem {
  readonly key: string;
  readonly label: ReactNode;
  readonly disabled?: boolean;
}

export interface TabsProps {
  readonly items: ReadonlyArray<TabItem>;
  readonly value: string;
  readonly onChange: (key: string) => void;
  readonly ariaLabel?: string;
  readonly children?: ReactNode;
}

export function Tabs({ items, value, onChange, ariaLabel, children }: TabsProps): JSX.Element {
  return (
    <div className="zv-tabs">
      <div
        className="zv-tabs__list"
        role="tablist"
        aria-label={ariaLabel}
        data-testid="zv-tabs-list"
      >
        {items.map((item) => {
          const active = item.key === value;
          return (
            <button
              key={item.key}
              type="button"
              role="tab"
              id={`zv-tab-${item.key}`}
              aria-selected={active}
              aria-controls={`zv-tabpanel-${item.key}`}
              tabIndex={active ? 0 : -1}
              disabled={item.disabled}
              className={`zv-tabs__tab${active ? ' zv-tabs__tab--active' : ''}`}
              onClick={() => onChange(item.key)}
              data-testid={`zv-tab-${item.key}`}
            >
              {item.label}
            </button>
          );
        })}
      </div>
      <div
        className="zv-tabs__panel"
        role="tabpanel"
        id={`zv-tabpanel-${value}`}
        aria-labelledby={`zv-tab-${value}`}
        data-testid={`zv-tabpanel-${value}`}
      >
        {children}
      </div>
    </div>
  );
}
