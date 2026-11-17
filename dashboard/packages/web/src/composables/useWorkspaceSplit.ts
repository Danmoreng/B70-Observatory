import { computed, ref } from 'vue';
const KEY = 'observatory.workspace.split';
export const clampSplit = (value: number) => Math.min(75, Math.max(25, value));
export function useWorkspaceSplit() {
  let stored = 52;
  try {
    const value = Number(localStorage.getItem(KEY));
    if (Number.isFinite(value) && value >= 25 && value <= 75) stored = value;
  } catch {
    /* session only */
  }
  const ratio = ref(stored);
  const element = ref<HTMLElement>();
  let pointer: number | undefined;
  function persist() {
    try {
      localStorage.setItem(KEY, String(ratio.value));
    } catch {
      /* session only */
    }
  }
  function move(event: PointerEvent) {
    if (pointer !== event.pointerId) return;
    const rect = element.value?.getBoundingClientRect();
    if (rect && rect.width > 0)
      ratio.value = clampSplit(((event.clientX - rect.left) / rect.width) * 100);
  }
  function start(event: PointerEvent) {
    if (event.button !== 0) return;
    pointer = event.pointerId;
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    event.preventDefault();
  }
  function end(event: PointerEvent) {
    if (pointer !== event.pointerId) return;
    pointer = undefined;
    persist();
  }
  function key(event: KeyboardEvent) {
    const value =
      event.key === 'ArrowLeft'
        ? ratio.value - 2
        : event.key === 'ArrowRight'
          ? ratio.value + 2
          : event.key === 'Home'
            ? 25
            : event.key === 'End'
              ? 75
              : undefined;
    if (value === undefined) return;
    event.preventDefault();
    ratio.value = clampSplit(value);
    persist();
  }
  const style = computed(() => ({
    gridTemplateColumns:
      'minmax(0, ' + ratio.value + 'fr) 10px minmax(0, ' + (100 - ratio.value) + 'fr)',
  }));
  return { element, ratio, style, start, move, end, key };
}
