import { For, Show } from 'solid-js';
import type { NamedValue } from '../types';
import type { KeyValueRowValidationErrors } from '../validation';
import { namedValue } from '../utils';
import ActionButton from './ActionButton';


export interface KeyValueEditorProps {
  rows: NamedValue[];
  onRowsChange: (next: NamedValue[]) => void;
  kind: string;
  idPrefix: string;
  keyLabel?: string;
  valueLabel?: string;
  addLabel?: string;
  secret?: boolean;
  disabled?: boolean;
  errors?: Record<string, KeyValueRowValidationErrors | undefined>;
}

export default function KeyValueEditor(props: KeyValueEditorProps) {
  const keyLabel = () => props.keyLabel ?? 'Key';
  const valueLabel = () => props.valueLabel ?? 'Value';
  const controlId = (rowId: string, control: string) => `${props.idPrefix}-${encodeURIComponent(rowId)}-${control}`;
  let editorElement!: HTMLDivElement;


  const updateRow = (id: string, update: Partial<Pick<NamedValue, 'enabled' | 'name' | 'value'>>) => {
    props.onRowsChange(props.rows.map((row) => (row.id === id ? { ...row, ...update } : row)));
  };

  const removeRow = (id: string) => {
    const index = props.rows.findIndex((row) => row.id === id);
    const remaining = props.rows.filter((row) => row.id !== id);
    const focusId = remaining[Math.min(index, remaining.length - 1)]?.id;
    props.onRowsChange(remaining);
    queueMicrotask(() => {
      if (focusId) document.getElementById(controlId(focusId, 'name'))?.focus();
      else editorElement.querySelector<HTMLButtonElement>(':scope > .action')?.focus();
    });
  };

  const appendRow = () => {
    const row = namedValue();
    props.onRowsChange([...props.rows, row]);
    queueMicrotask(() => document.getElementById(controlId(row.id, 'name'))?.focus());
  };

  return (
    <div ref={editorElement} class="kv-editor">
      <div class="kv-head" aria-hidden="true">
        <span>On</span>
        <span>{keyLabel()}</span>
        <span>{valueLabel()}</span>
        <span></span>
      </div>
      <Show
        when={props.rows.length > 0}
        fallback={<p class="inline-empty">No {props.kind.toLowerCase()} rows. Add one when needed.</p>}
      >
        <For each={props.rows.map((row) => row.id)}>
          {(id, index) => {
            const row = () => props.rows.find((candidate) => candidate.id === id)!;
            const position = () => index() + 1;
            const nameError = () => props.errors?.[id]?.name;
            const valueError = () => props.errors?.[id]?.value;
            const nameId = () => controlId(id, 'name');
            const valueId = () => controlId(id, 'value');

            return (
              <div class="kv-row">
                <label class="check-cell" title={`Enable ${props.kind} ${position()}`}>
                  <input
                    id={controlId(id, 'enabled')}
                    type="checkbox"
                    checked={row().enabled}
                    aria-label={`Enable ${props.kind} ${position()}`}
                    disabled={props.disabled}
                    onChange={(event) => updateRow(id, { enabled: event.currentTarget.checked })}
                  />
                </label>
                <div class="kv-control">
                  <input
                    id={nameId()}
                    class="mono"
                    value={row().name}
                    aria-label={`${props.kind} ${position()} ${keyLabel().toLowerCase()}`}
                    aria-invalid={nameError() ? 'true' : undefined}
                    aria-describedby={nameError() ? `${nameId()}-error` : undefined}
                    placeholder={keyLabel()}
                    disabled={props.disabled}
                    onInput={(event) => updateRow(id, { name: event.currentTarget.value })}
                  />
                  <Show when={nameError()}>
                    {(message) => <span id={`${nameId()}-error`} class="field-error" role="alert">{message()}</span>}
                  </Show>
                </div>
                <div class="kv-control">
                  <input
                    id={valueId()}
                    class="mono"
                    type={props.secret ? 'password' : 'text'}
                    value={row().value}
                    aria-label={`${props.kind} ${position()} ${valueLabel().toLowerCase()}`}
                    aria-invalid={valueError() ? 'true' : undefined}
                    aria-describedby={valueError() ? `${valueId()}-error` : undefined}
                    placeholder={valueLabel()}
                    disabled={props.disabled}
                    onInput={(event) => updateRow(id, { value: event.currentTarget.value })}
                  />
                  <Show when={valueError()}>
                    {(message) => <span id={`${valueId()}-error`} class="field-error" role="alert">{message()}</span>}
                  </Show>
                </div>
                <button
                  class="icon-button"
                  type="button"
                  aria-label={`Remove ${props.kind} ${position()}`}
                  title={`Remove ${props.kind} ${position()}`}
                  disabled={props.disabled}
                  onClick={() => removeRow(id)}
                >
                  ×
                </button>
              </div>
            );
          }}
        </For>
      </Show>
      <ActionButton onClick={appendRow} disabled={props.disabled}>+ {props.addLabel ?? 'Add row'}</ActionButton>
    </div>
  );
}
