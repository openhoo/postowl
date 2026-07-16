import { Show } from 'solid-js';

const FIELD_ERROR_CLASS = 'field-error mt-1 text-[0.6875rem] leading-[1.4] text-coral-ink';

export interface FieldErrorProps {
  message?: string;
  id?: string;
  class?: string;
}

export default function FieldError(props: FieldErrorProps) {
  return (
    <Show when={props.message}>
      {(message) => (
        <span id={props.id} class={`${FIELD_ERROR_CLASS} ${props.class ?? ''}`} role="alert">
          {message()}
        </span>
      )}
    </Show>
  );
}
