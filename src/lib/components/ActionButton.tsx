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
      class={`action min-h-control-default cursor-pointer whitespace-nowrap rounded-sm border px-3 py-1 text-[0.8125rem] font-[650] transition-[border-color,background-color,color,box-shadow,transform] duration-[140ms] ease-out focus-visible:relative focus-visible:z-[2] focus-visible:outline-0 focus-visible:shadow-[0_0_0_0.125rem_var(--color-raised),0_0_0_0.25rem_var(--color-signal)] disabled:cursor-not-allowed disabled:opacity-[0.48] active:enabled:translate-y-px ${
        props.tone === 'primary'
          ? 'border-naval bg-naval font-[750] text-raised shadow-[inset_0_0.125rem_var(--color-signal-bright)] enabled:hover:border-graphite enabled:hover:bg-graphite enabled:hover:text-raised'
          : props.tone === 'danger'
            ? 'border-transparent bg-transparent text-coral-ink enabled:hover:border-coral-line enabled:hover:bg-coral-soft enabled:hover:text-coral-ink'
            : 'border-hairline bg-raised text-naval enabled:hover:border-signal-line enabled:hover:bg-signal-soft enabled:hover:text-graphite'
      }`}
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
