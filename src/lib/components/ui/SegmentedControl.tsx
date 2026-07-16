import { For, type JSX } from 'solid-js';

const GROUP_CLASS = 'segmented flex w-fit rounded-md border border-hairline bg-canvas p-[0.1875rem]';
const BUTTON_CLASS = 'min-h-[1.875rem] min-w-15 rounded-sm border-0 bg-transparent px-3 py-1.5 text-xs text-ink-muted disabled:cursor-not-allowed';
const ACTIVE_CLASS = 'active bg-naval text-raised';

export interface SegmentedControlItem<T extends string> {
  value: T;
  label: JSX.Element;
  disabled?: boolean;
  title?: string;
}

export interface SegmentedControlProps<T extends string> {
  items: readonly SegmentedControlItem<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  disabled?: boolean;
  class?: string;
  buttonClass?: string;
  activeClass?: string;
  inactiveClass?: string;
}

export default function SegmentedControl<T extends string>(props: SegmentedControlProps<T>) {
  return (
    <div class={`${GROUP_CLASS} ${props.class ?? ''}`} aria-label={props.ariaLabel} role="group">
      <For each={props.items}>
        {(item) => {
          const active = () => props.value === item.value;
          return (
            <button
              type="button"
              class={`${BUTTON_CLASS} ${props.buttonClass ?? ''} ${active() ? `${ACTIVE_CLASS} ${props.activeClass ?? ''}` : props.inactiveClass ?? ''}`}
              aria-pressed={active()}
              disabled={props.disabled || item.disabled}
              title={item.title}
              onClick={() => props.onChange(item.value)}
            >
              {item.label}
            </button>
          );
        }}
      </For>
    </div>
  );
}
