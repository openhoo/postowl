import { For, Show } from 'solid-js';
import type { NamedValue } from '../types';
import { namedValue } from '../utils';
import ActionButton from './ActionButton';

export interface KeyValueEditorProps {
  rows: NamedValue[];
  onRowsChange: (next: NamedValue[]) => void;
  keyLabel?: string;
  valueLabel?: string;
  addLabel?: string;
  secret?: boolean;
}

export default function KeyValueEditor(props: KeyValueEditorProps) {
  const keyLabel = () => props.keyLabel ?? 'Key';
  const valueLabel = () => props.valueLabel ?? 'Value';

  const updateRow = (id: string, update: Partial<Pick<NamedValue, 'enabled' | 'name' | 'value'>>) => {
    props.onRowsChange(props.rows.map((row) => (row.id === id ? { ...row, ...update } : row)));
  };

  const removeRow = (id: string) => {
    props.onRowsChange(props.rows.filter((row) => row.id !== id));
  };

  const appendRow = () => {
    props.onRowsChange([...props.rows, namedValue()]);
  };

  return (
    <div class="kv-editor">
      <div class="kv-head" aria-hidden="true">
        <span>On</span>
        <span>{keyLabel()}</span>
        <span>{valueLabel()}</span>
        <span></span>
      </div>
      <Show
        when={props.rows.length > 0}
        fallback={<p class="inline-empty">No rows. Add one when this request needs it.</p>}
      >
        <For each={props.rows.map((row) => row.id)}>
          {(id) => {
            const row = () => props.rows.find((candidate) => candidate.id === id)!;

            return (
              <div class="kv-row">
                <label class="check-cell" title="Enable row">
                  <input
                    type="checkbox"
                    checked={row().enabled}
                    aria-label={`Enable ${row().name || 'row'}`}
                    onChange={(event) => updateRow(id, { enabled: event.currentTarget.checked })}
                  />
                </label>
                <input
                  class="mono"
                  value={row().name}
                  aria-label={keyLabel()}
                  placeholder={keyLabel()}
                  onInput={(event) => updateRow(id, { name: event.currentTarget.value })}
                />
                <input
                  class="mono"
                  type={props.secret ? 'password' : 'text'}
                  value={row().value}
                  aria-label={valueLabel()}
                  placeholder={valueLabel()}
                  onInput={(event) => updateRow(id, { value: event.currentTarget.value })}
                />
                <button
                  class="icon-button"
                  type="button"
                  aria-label="Remove row"
                  title="Remove row"
                  onClick={() => removeRow(id)}
                >
                  ×
                </button>
              </div>
            );
          }}
        </For>
      </Show>
      <ActionButton onClick={appendRow}>＋ {props.addLabel ?? 'Add row'}</ActionButton>
    </div>
  );
}
