<script lang="ts">
  let {
    type = 'button',
    tone = 'quiet',
    disabled = false,
    title,
    onclick,
    children
  }: {
    type?: 'button' | 'submit';
    tone?: 'primary' | 'quiet' | 'danger';
    disabled?: boolean;
    title?: string;
    onclick?: (event: MouseEvent) => void;
    children: import('svelte').Snippet;
  } = $props();
</script>

<button {type} class:primary={tone === 'primary'} class:danger={tone === 'danger'} class="action" {disabled} {title} {onclick}>
  {@render children()}
</button>
