import { useEffect, useState, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, CloseButton } from '@/components/ui';

interface FieldDef {
  name: string;
  dataType: string;
}

interface FilterBuilderProps {
  fields: ReadonlyArray<FieldDef>;
  value?: string;
  onApply?: (expr: string) => void;
  onChange?: (expr: string) => void;
}

type FilterMode = 'sql' | 'builder';

interface FilterCondition {
  id: string;
  field: string;
  op: string;
  value: string;
}

const OPS_BY_TYPE: Record<string, { label: string; value: string }[]> = {
  STRING: [
    { label: '=', value: '=' },
    { label: '!=', value: '!=' },
    { label: 'contains', value: 'contains' },
    { label: 'starts with', value: 'starts_with' },
    { label: 'like', value: 'like' },
  ],
  INT64: [
    { label: '=', value: '=' },
    { label: '!=', value: '!=' },
    { label: '>', value: '>' },
    { label: '>=', value: '>=' },
    { label: '<', value: '<' },
    { label: '<=', value: '<=' },
  ],
  FLOAT: [
    { label: '=', value: '=' },
    { label: '!=', value: '!=' },
    { label: '>', value: '>' },
    { label: '>=', value: '>=' },
    { label: '<', value: '<' },
    { label: '<=', value: '<=' },
  ],
  DOUBLE: [
    { label: '=', value: '=' },
    { label: '!=', value: '!=' },
    { label: '>', value: '>' },
    { label: '>=', value: '>=' },
    { label: '<', value: '<' },
    { label: '<=', value: '<=' },
  ],
  BOOL: [
    { label: '=', value: '=' },
    { label: '!=', value: '!=' },
  ],
};

function getOpsForType(dataType: string): { label: string; value: string }[] {
  return OPS_BY_TYPE[dataType] ?? OPS_BY_TYPE['STRING'];
}

function buildExpression(conditions: FilterCondition[], fields: ReadonlyArray<FieldDef>): string {
  return conditions
    .filter((c) => c.field && c.value)
    .map((c) => {
      const fieldDef = fields.find((f) => f.name === c.field);
      const isString = fieldDef?.dataType === 'STRING';
      if (c.op === 'contains') {
        const escaped = c.value.replace(/'/g, "\\'");
        return `${c.field} like '%${escaped}%'`;
      }
      if (c.op === 'starts_with') {
        const escaped = c.value.replace(/'/g, "\\'");
        return `${c.field} like '${escaped}%'`;
      }
      if (c.op === 'like') {
        const escaped = c.value.replace(/'/g, "\\'");
        return `${c.field} like '${escaped}'`;
      }
      const val = isString ? `'${c.value.replace(/'/g, "\\'")}'` : c.value;
      return `${c.field} ${c.op} ${val}`;
    })
    .join(' AND ');
}

function makeCondition(fields: ReadonlyArray<FieldDef>): FilterCondition {
  const first = fields.find((f) => f.name !== 'id') ?? fields[0];
  const ops = first ? getOpsForType(first.dataType) : [];
  return {
    id: `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    field: first?.name ?? '',
    op: ops[0]?.value ?? '=',
    value: '',
  };
}

export function FilterBuilder({ fields, value, onApply, onChange }: FilterBuilderProps): JSX.Element {
  const { t } = useTranslation();
  const [mode, setMode] = useState<FilterMode>('sql');
  const [sqlText, setSqlText] = useState(value ?? '');
  const [conditions, setConditions] = useState<FilterCondition[]>(() => [makeCondition(fields)]);

  const conditionsRef = useRef(conditions);
  conditionsRef.current = conditions;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const sqlTextRef = useRef(sqlText);
  sqlTextRef.current = sqlText;

  const scalarFields = useMemo(
    () => fields.filter((f) => f.name !== 'id'),
    [fields],
  );

  useEffect(() => {
    if (value !== undefined && modeRef.current === 'sql' && value !== sqlTextRef.current) {
      setSqlText(value);
    }
  }, [value]);

  function handleApply(): void {
    if (modeRef.current === 'sql') {
      onApply?.(sqlTextRef.current.trim());
    } else {
      const expr = buildExpression(conditionsRef.current, fields);
      onApply?.(expr);
    }
  }

  function emitChange(nextSql?: string, nextConditions?: FilterCondition[]): void {
    if (!onChange) return;
    if (modeRef.current === 'sql') {
      onChange((nextSql ?? sqlTextRef.current).trim());
    } else {
      onChange(buildExpression(nextConditions ?? conditionsRef.current, fields));
    }
  }

  function addCondition(): void {
    setConditions((prev) => {
      const next = [...prev, makeCondition(fields)];
      if (onChange) emitChange(undefined, next);
      return next;
    });
  }

  function removeCondition(id: string): void {
    setConditions((prev) => {
      if (prev.length <= 1) return prev;
      const next = prev.filter((c) => c.id !== id);
      if (onChange) emitChange(undefined, next);
      return next;
    });
  }

  function updateCondition(id: string, patch: Partial<FilterCondition>): void {
    setConditions((prev) => {
      const next = prev.map((c) => {
        if (c.id !== id) return c;
        const updated = { ...c, ...patch };
        if (patch.field && patch.field !== c.field) {
          const fieldDef = fields.find((f) => f.name === patch.field);
          const ops = fieldDef ? getOpsForType(fieldDef.dataType) : [];
          updated.op = ops[0]?.value ?? '=';
        }
        return updated;
      });
      if (onChange) emitChange(undefined, next);
      return next;
    });
  }

  return (
    <div className="zv-filter-builder">
      <div className="zv-filter-builder__bar">
        <div className="zv-input-mode-tabs" style={{ flexShrink: 0 }}>
          <button
            type="button"
            className={`zv-input-mode-tab${mode === 'sql' ? ' zv-input-mode-tab--active' : ''}`}
            onClick={() => {
              setMode('sql');
              if (onChange) onChange(sqlTextRef.current.trim());
            }}
          >
            SQL
          </button>
          <button
            type="button"
            className={`zv-input-mode-tab${mode === 'builder' ? ' zv-input-mode-tab--active' : ''}`}
            onClick={() => {
              setMode('builder');
              if (onChange) onChange(buildExpression(conditionsRef.current, fields));
            }}
          >
            {t('pages.collections.detail.filter.builder')}
          </button>
        </div>

        {mode === 'sql' ? (
          <input
            className="zv-form-input"
            type="text"
            placeholder={t('pages.collections.detail.filter.sqlPlaceholder')}
            value={sqlText}
            onChange={(e) => { setSqlText(e.target.value); if (onChange) emitChange(e.target.value); }}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleApply(); } }}
            spellCheck={false}
            autoComplete="off"
            style={{ flex: 1 }}
          />
        ) : (
          <div className="zv-filter-builder__conditions" style={{ flex: 1 }}>
            {conditions.map((cond) => {
              const fieldDef = fields.find((f) => f.name === cond.field);
              const ops = fieldDef ? getOpsForType(fieldDef.dataType) : getOpsForType('STRING');
              return (
                <div key={cond.id} className="zv-filter-condition">
                  <select
                    className="zv-form-select zv-filter-condition__field"
                    value={cond.field}
                    onChange={(e) => updateCondition(cond.id, { field: e.target.value })}
                  >
                    {scalarFields.map((f) => (
                      <option key={f.name} value={f.name}>{f.name}</option>
                    ))}
                  </select>
                  <select
                    className="zv-form-select zv-filter-condition__op"
                    value={cond.op}
                    onChange={(e) => updateCondition(cond.id, { op: e.target.value })}
                  >
                    {ops.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                  <input
                    className="zv-form-input zv-filter-condition__value"
                    type="text"
                    placeholder={t('pages.collections.detail.filter.valuePlaceholder')}
                    value={cond.value}
                    onChange={(e) => updateCondition(cond.id, { value: e.target.value })}
                    onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); handleApply(); } }}
                    spellCheck={false}
                  />
                  {conditions.length > 1 && (
                    <CloseButton
                      className="zv-filter-condition__remove"
                      onClick={() => removeCondition(cond.id)}
                    />
                  )}
                </div>
              );
            })}
            {scalarFields.length > 0 && (
              <button type="button" className="zv-filter-condition__add" onClick={addCondition}>
                + {t('pages.collections.detail.filter.addCondition')}
              </button>
            )}
          </div>
        )}

        {onApply && (
          <Button variant="primary" type="button" onClick={handleApply}>
            {t('pages.collections.detail.browse.filterBtn')}
          </Button>
        )}
      </div>
    </div>
  );
}
