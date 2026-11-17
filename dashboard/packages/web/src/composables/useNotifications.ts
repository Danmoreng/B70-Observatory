import { onScopeDispose, ref, watch, type WatchSource } from 'vue';

export type NotificationKind = 'error' | 'warn' | 'notice';
export const notifications = ref<{ id: string; text: string; kind: NotificationKind }[]>([]);
export function dismissNotification(id: string) {
  notifications.value = notifications.value.filter((item) => item.id !== id);
}
export function notify(id: string, text: string, kind: NotificationKind = 'error') {
  if (!text) return dismissNotification(id);
  const existing = notifications.value.find((item) => item.id === id);
  if (existing?.text === text && existing.kind === kind) return;
  notifications.value = [
    ...notifications.value.filter((item) => item.id !== id),
    { id, text, kind },
  ].slice(-5);
}
export function useNotification(
  source: WatchSource<string>,
  id: string,
  kind: NotificationKind = 'error'
) {
  watch(source, (text) => notify(id, text, kind), { immediate: true });
  onScopeDispose(() => dismissNotification(id));
}
