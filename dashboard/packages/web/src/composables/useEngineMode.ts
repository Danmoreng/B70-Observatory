import { onScopeDispose, ref, watch, type Ref } from 'vue';
import { EngineModeStateSchema, type EngineMode } from '@observatory/contracts';
export const engineMode = ref(
  EngineModeStateSchema.parse({
    mode: 'text',
    changing: false,
    imageTools: false,
    agentsAllowed: true,
    available: false,
  })
);
export const modeError = ref('');
export const settingMode = ref(false);
export function useEngineModePolling(enabled: Ref<boolean>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  const stop = () => {
    clearTimeout(timer);
    controller?.abort();
  };
  watch(
    enabled,
    (active) => {
      stop();
      if (!active) return;
      const session = new AbortController();
      controller = session;
      async function poll() {
        if (!document.hidden) await refreshEngineMode(session.signal).catch(() => {});
        if (!session.signal.aborted) timer = setTimeout(poll, 3000);
      }
      void poll();
    },
    { immediate: true }
  );
  onScopeDispose(stop);
}
export async function refreshEngineMode(signal?: AbortSignal) {
  const response = await fetch('/api/engine/mode', {
    cache: 'no-store',
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(10000)])
      : AbortSignal.timeout(10000),
  });
  if (!response.ok) return;
  engineMode.value = EngineModeStateSchema.parse(await response.json());
}
export async function setEngineMode(mode: EngineMode) {
  if (settingMode.value) return;
  settingMode.value = true;
  modeError.value = '';
  try {
    const response = await fetch('/api/engine/mode', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
      signal: AbortSignal.timeout(35 * 60_000),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error?.message ?? 'Engine mode change failed.');
    engineMode.value = EngineModeStateSchema.parse(body);
  } catch (error) {
    modeError.value = (error as Error).message;
  } finally {
    settingMode.value = false;
    await refreshEngineMode().catch(() => {});
  }
}
