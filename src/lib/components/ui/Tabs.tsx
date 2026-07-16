import { For, type JSX } from 'solid-js';

const TAB_BUTTON_CLASS = 'relative h-11 border-0 border-b-[0.1875rem] border-transparent bg-transparent p-0 text-[0.8125rem] font-semibold capitalize text-ink-muted';
const ACTIVE_TAB_CLASS = 'active border-signal text-graphite font-[750]';

export interface TabsProps<T extends string> {
  items: readonly T[];
  value: T;
  onChange: (value: T) => void;
  idPrefix: string;
  panelId: string;
  ariaLabel: string;
  renderLabel?: (item: T) => JSX.Element;
  class?: string;
  buttonClass?: string;
  activeClass?: string;
  inactiveClass?: string;
}

export default function Tabs<T extends string>(props: TabsProps<T>) {
  const moveFocus = (event: KeyboardEvent & { currentTarget: HTMLButtonElement }, current: T) => {
    const currentIndex = props.items.indexOf(current);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? props.items.length - 1
        : event.key === 'ArrowLeft'
          ? (currentIndex - 1 + props.items.length) % props.items.length
          : event.key === 'ArrowRight'
            ? (currentIndex + 1) % props.items.length
            : currentIndex;
    if (nextIndex === currentIndex && event.key !== 'Home' && event.key !== 'End') return;

    const tabButtons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    event.preventDefault();
    props.onChange(props.items[nextIndex]);
    queueMicrotask(() => tabButtons?.[nextIndex]?.focus());
  };

  return (
    <nav class={`tabs ${props.class ?? ''}`} aria-label={props.ariaLabel} role="tablist">
      <For each={props.items}>
        {(item) => {
          const active = () => props.value === item;
          return (
            <button
              type="button"
              role="tab"
              aria-selected={active()}
              id={`${props.idPrefix}-tab-${item}`}
              aria-controls={props.panelId}
              tabindex={active() ? 0 : -1}
              class={`${TAB_BUTTON_CLASS} ${props.buttonClass ?? ''} ${active() ? `${ACTIVE_TAB_CLASS} ${props.activeClass ?? ''}` : props.inactiveClass ?? ''}`}
              onClick={() => props.onChange(item)}
              onKeyDown={(event) => moveFocus(event, item)}
            >
              {props.renderLabel ? props.renderLabel(item) : item}
            </button>
          );
        }}
      </For>
    </nav>
  );
}
