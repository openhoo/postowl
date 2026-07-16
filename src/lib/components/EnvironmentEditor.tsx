import { createSignal } from 'solid-js';
import type { Environment } from '../types';
import ActionButton from './ActionButton';
import KeyValueEditor from './KeyValueEditor';

interface EnvironmentEditorProps {
  draft: Environment;
  saving: boolean;
  onDraftChange: (next: Environment) => void;
  onSave: () => void;
  onDelete: () => void;
}

export default function EnvironmentEditor(props: EnvironmentEditorProps) {
  const [concealValues, setConcealValues] = createSignal(false);


  return (
    <section class="entity-editor environment-editor" aria-label="Environment editor">
      <header class="entity-header">
        <div>
          <span class="eyebrow">VARIABLE DECK</span>
          <h1>Environment</h1>
          <p>Variables replace matching <code>{'{{name}}'}</code> tokens when a request is sent.</p>
        </div>
        <div class="toolbar-actions">
          <ActionButton tone="danger" onClick={props.onDelete}>Delete</ActionButton>
          <ActionButton tone="primary" disabled={props.saving} onClick={props.onSave}>
            {props.saving ? 'Saving…' : 'Save environment'}
          </ActionButton>
        </div>
      </header>
      <label class="stacked-field">
        <span>Name</span>
        <input
          class="large-field"
          value={props.draft.name}
          onInput={(event) => props.onDraftChange({ ...props.draft, name: event.currentTarget.value })}
          aria-label="Environment name"
        />
      </label>
      <div class="section-heading">
        <div>
          <h2>Variables</h2>
          <p>Disabled variables stay saved but are not substituted.</p>
        </div>
        <label class="toggle-label">
          <input
            type="checkbox"
            checked={concealValues()}
            onChange={(event) => setConcealValues(event.currentTarget.checked)}
          />{' '}
          Conceal values
        </label>
      </div>
      <KeyValueEditor
        rows={props.draft.variables}
        onRowsChange={(variables) => props.onDraftChange({ ...props.draft, variables })}
        keyLabel="Variable"
        valueLabel="Value"
        addLabel="Add variable"
        secret={concealValues()}
      />
    </section>
  );
}
