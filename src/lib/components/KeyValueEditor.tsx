import { For, Show } from 'solid-js';
import type { NamedValue } from '../types';
import type { KeyValueRowValidationErrors } from '../validation';
import { namedValue } from '../utils';
import FieldError from './ui/FieldError';

const KV_CONTROL_CLASS = 'min-h-control-default min-w-0 w-full rounded-none border border-hairline bg-raised px-2 py-1 font-data placeholder:text-ink-faint hover:border-signal-line focus-visible:relative focus-visible:z-2 focus-visible:outline-0 focus-visible:[box-shadow:var(--focus-ring)] aria-invalid:border-coral-line disabled:cursor-not-allowed disabled:opacity-48';
const KV_ACTION_CLASS = 'mt-3 mr-3 ml-3 min-h-control-default w-fit max-w-[calc(100%_-_1.5rem)] whitespace-nowrap rounded-sm border border-hairline bg-raised px-3 py-1 text-[0.8125rem] font-[650] text-naval transition-[border-color,background-color,color,box-shadow,transform] duration-[140ms] ease-out hover:not-disabled:border-signal-line hover:not-disabled:bg-signal-soft hover:not-disabled:text-graphite active:not-disabled:translate-y-px focus-visible:relative focus-visible:z-2 focus-visible:outline-0 focus-visible:[box-shadow:var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-48 max-[36rem]:whitespace-normal';
const KV_GRID_CLASS = 'grid grid-cols-[2.5rem_minmax(7rem,0.85fr)_minmax(9rem,1.15fr)_2rem] items-center max-[36rem]:grid-cols-[1.75rem_minmax(4rem,0.85fr)_minmax(5rem,1.15fr)_var(--spacing-control-compact)]';


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
  fill?: boolean;
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
    <div
      ref={editorElement}
      class="kv-editor grid grid-cols-1 content-start gap-0 border border-hairline bg-raised pb-4"
      classList={{ 'h-full': props.fill }}
    >
      <div class={`kv-head ${KV_GRID_CLASS} min-h-8 border-b border-hairline bg-canvas px-2 font-data text-[0.6875rem] leading-none font-bold tracking-[0.05em] text-ink-muted uppercase max-[36rem]:px-1`} aria-hidden="true">
        <span>On</span>
        <span>{keyLabel()}</span>
        <span>{valueLabel()}</span>
        <span></span>
      </div>
      <Show
        when={props.rows.length > 0}
        fallback={<p class="inline-empty mx-3 my-4 text-[0.8125rem] text-ink-muted">No {props.kind.toLowerCase()} rows. Add one when needed.</p>}
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
              <div class={`kv-row ${KV_GRID_CLASS} min-h-11 border-b border-hairline bg-raised px-2 py-1 focus-within:relative focus-within:z-1 focus-within:border-signal-line max-[36rem]:px-1`}>
                <label class="check-cell grid place-items-center" title={`Enable ${props.kind} ${position()}`}>
                  <input
                    id={controlId(id, 'enabled')}
                    type="checkbox"
                    checked={row().enabled}
                    aria-label={`Enable ${props.kind} ${position()}`}
                    disabled={props.disabled}
                    class="size-4 min-h-0 accent-signal focus-visible:relative focus-visible:z-2 focus-visible:outline-0 focus-visible:[box-shadow:var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-48"
                    onChange={(event) => updateRow(id, { enabled: event.currentTarget.checked })}
                  />
                </label>
                <div class="kv-control grid min-w-0 content-start">
                  <input
                    id={nameId()}
                    class={`mono ${KV_CONTROL_CLASS}`}
                    value={row().name}
                    aria-label={`${props.kind} ${position()} ${keyLabel().toLowerCase()}`}
                    aria-invalid={nameError() ? 'true' : undefined}
                    aria-describedby={nameError() ? `${nameId()}-error` : undefined}
                    placeholder={keyLabel()}
                    disabled={props.disabled}
                    onInput={(event) => updateRow(id, { name: event.currentTarget.value })}
                  />
                  <FieldError id={`${nameId()}-error`} message={nameError()} />
                </div>
                <div class="kv-control grid min-w-0 content-start">
                  <input
                    id={valueId()}
                    class={`mono ${KV_CONTROL_CLASS}`}
                    type={props.secret ? 'password' : 'text'}
                    value={row().value}
                    aria-label={`${props.kind} ${position()} ${valueLabel().toLowerCase()}`}
                    aria-invalid={valueError() ? 'true' : undefined}
                    aria-describedby={valueError() ? `${valueId()}-error` : undefined}
                    placeholder={valueLabel()}
                    disabled={props.disabled}
                    onInput={(event) => updateRow(id, { value: event.currentTarget.value })}
                  />
                  <FieldError id={`${valueId()}-error`} message={valueError()} />
                </div>
                <button
                  class="icon-button relative grid size-control-compact shrink-0 place-items-center rounded-sm border border-hairline bg-raised p-0 text-ink-muted transition-[border-color,background-color,color,box-shadow,transform] duration-[140ms] ease-out after:absolute after:-inset-1 after:content-[''] hover:not-disabled:border-signal-line hover:not-disabled:bg-signal-soft hover:not-disabled:text-graphite active:not-disabled:translate-y-px focus-visible:z-2 focus-visible:outline-0 focus-visible:[box-shadow:var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-48"
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
      <button type="button" class={`action ${KV_ACTION_CLASS}`} onClick={appendRow} disabled={props.disabled}>+ {props.addLabel ?? 'Add row'}</button>
    </div>
  );
}
