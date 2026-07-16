import { createEffect, createMemo, createSignal } from 'solid-js';
import type { Environment } from '../types';
import ActionButton from './ActionButton';
import KeyValueEditor from './KeyValueEditor';
import FieldError from './ui/FieldError';

export interface EnvironmentValidationErrors {
  name?: string;
  summary?: string;
  variables?: Record<string, { name?: string; value?: string }>;
}

interface EnvironmentEditorProps {
  draft: Environment;
  dirty: boolean;
  errors?: EnvironmentValidationErrors;
  busy: boolean;
  onDraftChange: (next: Environment) => void;
  onSave: () => void;
  onDelete: () => void;
}

export default function EnvironmentEditor(props: EnvironmentEditorProps) {
  const [maskValues, setMaskValues] = createSignal(true);
  let environmentId = props.draft.id;
  createEffect(() => {
    const nextEnvironmentId = props.draft.id;
    if (nextEnvironmentId !== environmentId) {
      environmentId = nextEnvironmentId;
      setMaskValues(true);
    }
  });
  const nameError = createMemo(() => (
    props.errors?.name
    ?? (props.dirty && props.draft.name.trim().length === 0 ? 'Enter an environment name.' : undefined)
  ));
  const hasErrors = createMemo(() => (
    Boolean(nameError())
    || Object.values(props.errors?.variables ?? {}).some((error) => Boolean(error.name || error.value))
  ));

  return (
    <section
      class="entity-editor environment-editor h-full overflow-auto bg-panel p-8 @max-response:p-4 max-[36rem]:p-3"
      aria-label="Environment editor"
      aria-busy={props.busy}
    >
      <header class="entity-header relative flex items-start justify-between gap-6 border-b border-border-strong pb-6 after:absolute after:-bottom-px after:left-0 after:h-0.5 after:w-20 after:bg-signal after:content-[''] @max-response:flex-col @max-response:items-stretch max-[36rem]:gap-3 max-[36rem]:pb-3">
        <div>
          <span
            class="eyebrow request-state mb-1 flex items-center gap-1.5 font-data text-[0.6875rem] leading-none font-bold tracking-[0.04em] text-ink-muted"
            classList={{ dirty: props.dirty, 'text-coral-ink': props.dirty }}
          >
            <span class="state-dot size-[0.4375rem] rounded-full" classList={{ 'bg-signal': !props.dirty, 'bg-coral shadow-[0_0_0_0.1875rem_var(--color-coral-soft)]': props.dirty }} aria-hidden="true" />
            {props.dirty ? 'Unsaved changes' : 'Saved environment'}
          </span>
          <h1 class="my-1 mb-2 text-2xl font-[750] tracking-[-0.02em] text-graphite">Environment</h1>
          <p class="m-0 text-[0.8125rem] text-ink-muted">
            Variables replace matching <code class="text-coral-ink">{'{{name}}'}</code> tokens when a request is sent.
          </p>
        </div>
        <div class="toolbar-actions flex items-center gap-2 max-[36rem]:w-full max-[36rem]:flex-wrap max-[36rem]:gap-1 max-[36rem]:[&>.action]:min-w-0 max-[36rem]:[&>.action]:flex-[1_1_auto]">
          <ActionButton tone="danger" disabled={props.busy} onClick={props.onDelete}>Delete</ActionButton>
          <ActionButton
            tone="primary"
            disabled={props.busy || !props.dirty || hasErrors()}
            onClick={props.onSave}
          >
            {props.busy ? 'Working…' : props.dirty ? 'Save environment' : 'Saved'}
          </ActionButton>
        </div>
      </header>
      <label
        class="stacked-field my-6 grid max-w-[32rem] gap-2 text-xs font-[650] text-ink-muted"
        for="environment-name"
      >
        <span>Name</span>
        <input
          id="environment-name"
          class="large-field min-h-11 rounded-sm border border-hairline bg-raised px-2 py-1 text-base transition-[border-color,box-shadow] duration-[140ms] ease-out hover:border-signal-line focus-visible:relative focus-visible:z-[2] focus-visible:border-signal-line focus-visible:outline-0 focus-visible:shadow-[0_0_0_0.125rem_var(--color-raised),0_0_0_0.25rem_var(--color-signal)] disabled:cursor-not-allowed disabled:opacity-[0.48] aria-invalid:border-coral-line"
          value={props.draft.name}
          aria-label="Environment name"
          disabled={props.busy}
          onInput={(event) => props.onDraftChange({ ...props.draft, name: event.currentTarget.value })}
          aria-invalid={Boolean(nameError())}
          aria-describedby={nameError() ? 'environment-name-error' : undefined}
        />
        <FieldError id="environment-name-error" message={nameError()} />
        <FieldError message={props.errors?.summary} />
      </label>
      <div class="section-heading mb-3 flex items-end justify-between @max-response:flex-col @max-response:items-stretch max-[36rem]:gap-2">
        <div>
          <h2 class="mt-0 mb-1 text-base font-[750] text-graphite">Variables</h2>
          <p class="m-0 text-xs text-ink-muted">Disabled variables stay saved but are not substituted.</p>
        </div>
        <div class="grid gap-1">
          <label class="toggle-label flex items-center gap-2 text-xs text-ink-muted">
            <input
              class="size-4 min-h-0 accent-signal focus-visible:relative focus-visible:z-2 focus-visible:outline-0 focus-visible:[box-shadow:var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-[0.48]"
              type="checkbox"
              checked={maskValues()}
              onChange={(event) => setMaskValues(event.currentTarget.checked)}
            />{' '}
            Mask values
          </label>
          <p class="m-0 text-xs text-ink-muted">
            Masking only hides values on screen. Stored and exported values are not encrypted.
          </p>
        </div>
      </div>
      <KeyValueEditor
        rows={props.draft.variables}
        onRowsChange={(variables) => props.onDraftChange({ ...props.draft, variables })}
        keyLabel="Name"
        valueLabel="Value"
        addLabel="Add variable"
        kind="Variable"
        idPrefix="environment-variable"
        errors={props.errors?.variables}
        disabled={props.busy}
        secret={maskValues()}
      />
    </section>
  );
}
