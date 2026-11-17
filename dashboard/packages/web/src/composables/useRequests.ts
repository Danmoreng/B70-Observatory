import { onUnmounted, ref, watch, type Ref } from 'vue';
import {
  RequestListQuerySchema,
  type RequestDetail,
  type RequestListQuery,
  type RequestSummary,
} from '@observatory/contracts';
import { t } from '../lib/i18n.js';
import { fetchRequestDetail, fetchRequests } from '../lib/api.js';

export function useRequests(
  enabled: Ref<boolean>,
  minutes: Ref<number>,
  revision: Ref<number>,
  onError: (error: unknown) => void
) {
  const filters = ref({ status: '', model: '', id: '' });
  const items = ref<RequestSummary[]>([]);
  const nextCursor = ref<string | null>(null);
  const loading = ref(false);
  const error = ref('');
  const changed = ref(false);
  const selectedId = ref<string | null>(null);
  const detail = ref<RequestDetail | null>(null);
  const detailLoading = ref(false);
  const detailError = ref('');
  let query: RequestListQuery = {};
  let pages = 0;
  let controller: AbortController | undefined;
  let detailController: AbortController | undefined;
  let generation = 0;
  let detailGeneration = 0;
  let disposed = false;
  let queued = false;

  function cancel(): void {
    generation++;
    controller?.abort();
    loading.value = false;
    queued = false;
  }

  async function load(more = false, reuse = false): Promise<void> {
    if (!enabled.value || disposed) return;
    if (more && (!nextCursor.value || loading.value)) return;
    if (reuse && loading.value) {
      queued = true;
      return;
    }
    cancel();
    const epoch = generation;
    controller = new AbortController();
    const signal = controller.signal;
    if (!more && !reuse) {
      const now = Date.now();
      const result = RequestListQuerySchema.safeParse({
        from: new Date(now - minutes.value * 60_000).toISOString(),
        to: new Date(now).toISOString(),
        limit: 50,
        ...(filters.value.status ? { status: filters.value.status } : {}),
        ...(filters.value.model.trim() ? { model: filters.value.model.trim() } : {}),
        ...(filters.value.id.trim() ? { id: filters.value.id.trim() } : {}),
      });
      if (!result.success) {
        error.value = t('requests.invalidFilter');
        return;
      }
      query = result.data;
      pages = 0;
      items.value = [];
      nextCursor.value = null;
    } else if (reuse) {
      // A live first page follows the selected duration; pagination freezes its bounds.
      const now = Date.now();
      query = {
        ...query,
        from: new Date(now - minutes.value * 60_000).toISOString(),
        to: new Date(now).toISOString(),
      };
    }
    loading.value = true;
    error.value = '';
    try {
      const payload = await fetchRequests(
        { ...query, ...(more && nextCursor.value ? { cursor: nextCursor.value } : {}) },
        signal
      );
      if (disposed || epoch !== generation) return;
      items.value = more ? [...items.value, ...payload.items] : payload.items;
      nextCursor.value = payload.nextCursor;
      pages = more ? pages + 1 : 1;
      if (!more) changed.value = false;
    } catch (failure) {
      if (disposed || epoch !== generation || signal.aborted) return;
      error.value = failure instanceof Error ? failure.message : t('requests.loadFailed');
      onError(failure);
    } finally {
      if (epoch === generation && !disposed) {
        loading.value = false;
        if (queued) {
          queued = false;
          if (pages > 1) changed.value = true;
          else void load(false, true);
        }
      }
    }
  }

  async function select(id: string): Promise<void> {
    detailController?.abort();
    const epoch = ++detailGeneration;
    detailController = new AbortController();
    const signal = detailController.signal;
    if (selectedId.value !== id) detail.value = null;
    selectedId.value = id;
    detailLoading.value = true;
    detailError.value = '';
    try {
      const payload = await fetchRequestDetail(id, signal);
      if (!disposed && epoch === detailGeneration) detail.value = payload;
    } catch (failure) {
      if (disposed || epoch !== detailGeneration || signal.aborted) return;
      detailError.value = failure instanceof Error ? failure.message : t('requests.detailsFailed');
      onError(failure);
    } finally {
      if (!disposed && epoch === detailGeneration) detailLoading.value = false;
    }
  }
  function closeDetail(): void {
    detailGeneration++;
    detailController?.abort();
    selectedId.value = null;
    detail.value = null;
    detailLoading.value = false;
    detailError.value = '';
  }
  watch(revision, () => {
    if (!enabled.value) return;
    if (pages > 1) changed.value = true;
    else void load(false, true);
    if (selectedId.value) void select(selectedId.value);
  });
  watch(minutes, () => {
    if (enabled.value) void load();
  });
  watch(
    enabled,
    (value) => {
      cancel();
      closeDetail();
      items.value = [];
      nextCursor.value = null;
      error.value = '';
      pages = 0;
      changed.value = false;
      if (value) void load();
    },
    { immediate: true }
  );
  onUnmounted(() => {
    disposed = true;
    cancel();
    closeDetail();
  });
  return {
    filters,
    items,
    nextCursor,
    loading,
    error,
    changed,
    load,
    selectedId,
    detail,
    detailLoading,
    detailError,
    select,
    closeDetail,
  };
}
