import { onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';

/** Single-flight, cancellable polling. Hidden tabs and hidden panes do no work. */
export function useVisiblePolling<T>(options: {
  key: () => string;
  enabled: () => boolean;
  repeat: () => boolean;
  load: (signal: AbortSignal) => Promise<T>;
  intervalMs?: number;
}) {
  const data = shallowRef<T>();
  const error = ref('');
  const loading = ref(false);
  let generation = 0;
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  function available() {
    return !disposed && options.enabled() && globalThis.document?.visibilityState !== 'hidden';
  }
  function stop() {
    generation++;
    clearTimeout(timer);
    timer = undefined;
    controller?.abort();
    controller = undefined;
    loading.value = false;
  }
  async function refresh() {
    if (!available() || loading.value) return;
    clearTimeout(timer);
    const version = generation;
    const request = new AbortController();
    controller = request;
    loading.value = true;
    const timeout = setTimeout(() => request.abort(), 15_000);
    try {
      const next = await options.load(request.signal);
      if (version !== generation || disposed) return;
      data.value = next;
      error.value = '';
    } catch (cause) {
      if (version === generation && !disposed)
        error.value = cause instanceof Error ? cause.message : 'Request failed';
    } finally {
      clearTimeout(timeout);
      if (version === generation && !disposed) {
        loading.value = false;
        controller = undefined;
        if (available() && options.repeat())
          timer = setTimeout(() => void refresh(), options.intervalMs ?? 3_000);
      }
    }
  }
  let previousKey: string | undefined;
  watch(
    [options.key, options.enabled, options.repeat],
    ([key]) => {
      stop();
      if (key !== previousKey) {
        data.value = undefined;
        error.value = '';
        previousKey = key;
      }
      void refresh();
    },
    { immediate: true }
  );
  const visibilityChanged = () => {
    stop();
    void refresh();
  };
  onMounted(() => document.addEventListener('visibilitychange', visibilityChanged));
  onUnmounted(() => {
    disposed = true;
    stop();
    document.removeEventListener('visibilitychange', visibilityChanged);
  });
  return { data, error, loading, refresh };
}
