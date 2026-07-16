import { Show, createEffect, createMemo, createSignal } from 'solid-js';
import type { Environment } from '../types';
import ActionButton from './ActionButton';
import KeyValueEditor from './KeyValueEditor';

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
    <section class="entity-editor environment-editor" aria-label="Environment editor" aria-busy={props.busy}>
      <header class="entity-header">
        <div>
          <span class="eyebrow request-state" classList={{ dirty: props.dirty }}>
            <span class="state-dot" aria-hidden="true" />
            {props.dirty ? 'Unsaved changes' : 'Saved environment'}
          </span>
          <h1>Environment</h1>
          <p>Variables replace matching <code>{'{{name}}'}</code> tokens when a request is sent.</p>
        </div>
        <div class="toolbar-actions">
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
      <label class="stacked-field" for="environment-name">
        <span>Name</span>
        <input
          id="environment-name"
          class="large-field"
          value={props.draft.name}
          aria-label="Environment name"
          disabled={props.busy}
          onInput={(event) => props.onDraftChange({ ...props.draft, name: event.currentTarget.value })}
          aria-invalid={Boolean(nameError())}
          aria-describedby={nameError() ? 'environment-name-error' : undefined}
        />
        <Show when={nameError()}>
          {(error) => <span id="environment-name-error" class="field-error" role="alert">{error()}</span>}
        </Show>
        <Show when={props.errors?.summary}>
          {(error) => <span class="field-error" role="alert">{error()}</span>}
        </Show>
      </label>
      <div class="section-heading">
        <div>
          <h2>Variables</h2>
          <p>Disabled variables stay saved but are not substituted.</p>
        </div>
        <div>
          <label class="toggle-label">
            <input
              type="checkbox"
              checked={maskValues()}
              onChange={(event) => setMaskValues(event.currentTarget.checked)}
            />{' '}
            Mask values
          </label>
          <p>Masking only hides values on screen. Stored and exported values are not encrypted.</p>
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
