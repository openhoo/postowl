import { createMemo, createSignal, onCleanup, onMount, Show } from 'solid-js';
import { relaunch } from '@tauri-apps/plugin-process';
import { check, type DownloadEvent, type Update } from '@tauri-apps/plugin-updater';
import ActionButton from './ActionButton';

type UpdateState =
  | { phase: 'hidden' }
  | { phase: 'downloading'; version: string; downloaded: number; total?: number }
  | { phase: 'ready'; version: string }
  | { phase: 'error'; message: string };

type UpdateNoticeProps = {
  confirmRestart: () => Promise<boolean>;
};

const CHECK_DELAY_MS = 1_500;
const CHECK_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

export default function UpdateNotice(props: UpdateNoticeProps) {
  const [state, setState] = createSignal<UpdateState>({ phase: 'hidden' });
  const [busy, setBusy] = createSignal(false);
  let disposed = false;
  let checkTimer: number | undefined;

  const progress = createMemo(() => {
    const current = state();
    if (current.phase !== 'downloading' || !current.total) return null;
    return Math.min(100, Math.round((current.downloaded / current.total) * 100));
  });
  const downloading = createMemo(() => {
    const current = state();
    return current.phase === 'downloading' ? current : null;
  });
  const ready = createMemo(() => {
    const current = state();
    return current.phase === 'ready' ? current : null;
  });
  const failure = createMemo(() => {
    const current = state();
    return current.phase === 'error' ? current : null;
  });

  function onDownloadEvent(version: string, event: DownloadEvent) {
    if (disposed) return;
    if (event.event === 'Started') {
      setState({ phase: 'downloading', version, downloaded: 0, total: event.data.contentLength });
      return;
    }
    if (event.event === 'Progress') {
      setState((current) => current.phase === 'downloading'
        ? { ...current, downloaded: current.downloaded + event.data.chunkLength }
        : current);
    }
  }

  async function installAvailableUpdate() {
    if (busy()) return;
    setBusy(true);
    let update: Update | null = null;
    try {
      update = await check({ timeout: CHECK_TIMEOUT_MS });
      if (!update) {
        if (!disposed) setState({ phase: 'hidden' });
        return;
      }

      const version = update.version;
      if (!disposed) setState({ phase: 'downloading', version, downloaded: 0 });
      await update.downloadAndInstall(
        (event) => onDownloadEvent(version, event),
        { timeout: DOWNLOAD_TIMEOUT_MS }
      );
      if (!disposed) setState({ phase: 'ready', version });
    } catch (error) {
      console.error('Automatic update failed', error);
      if (!disposed) {
        setState({
          phase: 'error',
          message: 'PostOwl could not reach the update service. Check your connection and retry.'
        });
      }
      if (update) await update.close().catch(() => undefined);
    } finally {
      if (!disposed) setBusy(false);
    }
  }

  async function restart() {
    if (busy() || !(await props.confirmRestart())) return;
    setBusy(true);
    try {
      await relaunch();
    } catch (error) {
      console.error('Could not restart after update', error);
      if (!disposed) {
        setState({
          phase: 'error',
          message: 'The update is installed, but PostOwl could not restart. Close and reopen the app.'
        });
        setBusy(false);
      }
    }
  }

  onMount(() => {
    checkTimer = window.setTimeout(() => void installAvailableUpdate(), CHECK_DELAY_MS);
  });

  onCleanup(() => {
    disposed = true;
    window.clearTimeout(checkTimer);
  });

  return (
    <Show when={state().phase !== 'hidden'}>
      <aside
        class="fixed bottom-4 left-4 z-20 w-[min(28rem,calc(100vw-2rem))] overflow-hidden rounded-sm border border-border-strong bg-raised shadow-float before:absolute before:inset-x-0 before:top-0 before:h-0.75 before:bg-signal before:content-[''] max-[36rem]:bottom-2 max-[36rem]:left-2 max-[36rem]:w-[calc(100vw-1rem)]"
        aria-live="polite"
      >
        <Show when={downloading()}>
          {(current) => (
            <div class="px-4 pt-5 pb-4">
              <span class="font-data text-[0.6875rem] leading-none font-bold tracking-[0.07em] text-signal-ink uppercase">Automatic update</span>
              <div class="mt-2 flex items-center justify-between gap-4">
                <strong class="text-sm text-graphite">Installing PostOwl {current().version}</strong>
                <span class="font-data text-xs text-ink-muted">{progress() === null ? 'Downloading…' : `${progress()}%`}</span>
              </div>
              <div class="mt-3 h-1 overflow-hidden bg-signal-soft" aria-hidden="true">
                <div class="h-full bg-signal transition-[width] duration-150 motion-reduce:transition-none" style={{ width: `${progress() ?? 12}%` }} />
              </div>
            </div>
          )}
        </Show>

        <Show when={ready()}>
          {(current) => (
            <div class="flex items-center gap-4 px-4 pt-5 pb-4 max-[36rem]:items-start">
              <div class="min-w-0 flex-1">
                <span class="font-data text-[0.6875rem] leading-none font-bold tracking-[0.07em] text-signal-ink uppercase">Update ready</span>
                <strong class="mt-2 block text-sm text-graphite">PostOwl {current().version}</strong>
                <p class="mt-1 mb-0 text-[0.8125rem] leading-5 text-ink-muted">Restart to use the new version.</p>
              </div>
              <div class="flex shrink-0 gap-2">
                <ActionButton onClick={() => setState({ phase: 'hidden' })} disabled={busy()}>Later</ActionButton>
                <ActionButton tone="primary" onClick={() => void restart()} disabled={busy()}>{busy() ? 'Restarting…' : 'Restart'}</ActionButton>
              </div>
            </div>
          )}
        </Show>

        <Show when={failure()}>
          {(current) => (
            <div class="flex items-center gap-4 px-4 pt-5 pb-4 before:absolute before:inset-x-0 before:top-0 before:h-0.75 before:bg-coral before:content-[''] max-[36rem]:items-start">
              <div class="min-w-0 flex-1">
                <span class="font-data text-[0.6875rem] leading-none font-bold tracking-[0.07em] text-coral-ink uppercase">Update unavailable</span>
                <p class="mt-2 mb-0 line-clamp-2 text-[0.8125rem] leading-5 text-ink-muted">{current().message}</p>
              </div>
              <div class="flex shrink-0 gap-2">
                <ActionButton onClick={() => setState({ phase: 'hidden' })} disabled={busy()}>Dismiss</ActionButton>
                <ActionButton onClick={() => void installAvailableUpdate()} disabled={busy()}>{busy() ? 'Checking…' : 'Retry'}</ActionButton>
              </div>
            </div>
          )}
        </Show>
      </aside>
    </Show>
  );
}
