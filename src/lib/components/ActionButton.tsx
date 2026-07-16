import type { JSX } from 'solid-js';

export interface ActionButtonProps {
  type?: 'button' | 'submit';
  tone?: 'primary' | 'quiet' | 'danger';
  disabled?: boolean;
  title?: string;
  ariaLabel?: string;
  onClick?: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent>;
  children: JSX.Element;
}

export default function ActionButton(props: ActionButtonProps) {
  return (
    <button
      type={props.type ?? 'button'}
      class="action"
      classList={{
        primary: props.tone === 'primary',
        danger: props.tone === 'danger'
      }}
      disabled={props.disabled ?? false}
      title={props.title}
      aria-label={props.ariaLabel}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}
