<script setup lang="ts">
import { computed, nextTick, ref, toRef } from 'vue';
import { t } from '../lib/i18n.js';
import type { RequestStatus } from '@observatory/contracts';
import { useRequests } from '../composables/useRequests.js';
import {
  formatClock,
  formatInteger,
  formatMsAsSeconds,
  formatBytes,
  formatTimestamp,
} from '../lib/format.js';
const props = defineProps<{ enabled: boolean; minutes: number; revision: number }>();
const emit = defineEmits<{ error: [error: unknown] }>();
const requests = useRequests(
  toRef(props, 'enabled'),
  toRef(props, 'minutes'),
  toRef(props, 'revision'),
  (error) => emit('error', error)
);
const {
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
} = requests;
const labels = computed<Record<RequestStatus, string>>(() => ({
  in_progress: t('requests.statusRunning'),
  completed: t('requests.statusCompleted'),
  error: t('requests.statusError'),
  aborted: t('requests.statusAborted'),
}));
const eventLabels = computed<Record<string, string>>(() => ({
  start: t('requests.eventStart'),
  first_token: t('requests.eventFirstToken'),
  token: t('requests.eventToken'),
  complete: t('requests.eventComplete'),
  abort: t('requests.eventAbort'),
  error: t('requests.eventError'),
}));
const closeButton = ref<HTMLButtonElement>();
let opener: HTMLButtonElement | undefined;
async function openDetail(id: string, event: MouseEvent): Promise<void> {
  opener = event.currentTarget as HTMLButtonElement;
  void select(id);
  await nextTick();
  closeButton.value?.focus();
}
function close(): void {
  closeDetail();
  opener?.focus();
}
</script>

<template>
  <section class="requests-panel" aria-labelledby="request-title">
    <div class="section-heading">
      <div>
        <h2 id="request-title">{{ t('requests.title') }}</h2>
        <p class="section-caption">
          {{
            t('requests.caption', {
              window:
                minutes === 1440
                  ? t('requests.window24h')
                  : t('requests.windowMinutes', { minutes }),
            })
          }}
        </p>
      </div>
      <button class="quiet-button" type="button" :disabled="loading" @click="load()">
        {{ t('requests.refresh') }}
      </button>
    </div>
    <form class="request-filters" @submit.prevent="load()">
      <label
        >{{ t('requests.status')
        }}<select v-model="filters.status">
          <option value="">{{ t('requests.all') }}</option>
          <option v-for="(label, value) in labels" :key="value" :value="value">{{ label }}</option>
        </select></label
      >
      <label
        >{{ t('requests.model')
        }}<input v-model="filters.model" :placeholder="t('requests.allModels')" maxlength="128"
      /></label>
      <label class="id-filter"
        >Request-ID<input v-model="filters.id" placeholder="UUID" maxlength="36"
      /></label>
      <button type="submit" class="quiet-button">{{ t('requests.filter') }}</button>
    </form>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    <p v-if="changed" class="inline-notice" role="status">
      {{ t('requests.changed') }}
      <button type="button" class="text-button" @click="load()">
        {{ t('requests.showLatest') }}
      </button>
    </p>
    <div class="table-scroll" :aria-busy="loading">
      <table v-if="items.length">
        <caption class="sr-only">
          {{
            t('requests.tableCaption')
          }}
        </caption>
        <thead>
          <tr>
            <th scope="col">{{ t('requests.time') }}</th>
            <th scope="col">{{ t('requests.status') }}</th>
            <th scope="col">{{ t('requests.modelId') }}</th>
            <th scope="col">{{ t('requests.firstToken') }}</th>
            <th scope="col">{{ t('requests.duration') }}</th>
            <th scope="col">{{ t('requests.tokens') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in items" :key="item.id">
            <td class="numeric">{{ formatClock(item.startedAtUtc) }}</td>
            <td>
              <span class="request-status" :class="item.status">{{ labels[item.status] }}</span>
            </td>
            <td>
              <button
                type="button"
                class="request-link"
                :aria-label="t('requests.detailsAria', { id: item.id })"
                @click="openDetail(item.id, $event)"
              >
                {{ item.model ?? t('requests.unknownModel') }}<span>{{ item.id.slice(0, 8) }}</span>
              </button>
            </td>
            <td class="numeric">{{ formatMsAsSeconds(item.ttftMs) }}</td>
            <td class="numeric">{{ formatMsAsSeconds(item.durationMs) }}</td>
            <td class="numeric">
              {{ formatInteger(item.promptTokens) }} / {{ formatInteger(item.completionTokens) }}
            </td>
          </tr>
        </tbody>
      </table>
      <div v-else-if="!error" class="request-empty">
        <p>{{ loading ? t('requests.loading') : t('requests.empty') }}</p>
        <span v-if="!loading">
          {{ t('requests.onlyGateway') }}
        </span>
      </div>
    </div>
    <div v-if="nextCursor" class="load-more">
      <button type="button" class="quiet-button" :disabled="loading" @click="load(true)">
        {{ loading ? t('requests.loading') : t('requests.loadMore') }}
      </button>
    </div>
    <section
      v-if="selectedId"
      class="request-detail"
      :aria-label="t('requests.details')"
      @keydown.esc="close"
    >
      <div class="section-heading">
        <h3>{{ t('requests.details') }}</h3>
        <button ref="closeButton" type="button" class="quiet-button" @click="close">
          {{ t('requests.close') }}
        </button>
      </div>
      <p class="request-id">{{ selectedId }}</p>
      <p v-if="detailLoading" role="status">{{ t('requests.loadingDetails') }}</p>
      <p v-if="detailError" class="inline-error" role="alert">
        {{ detailError }}
        <button type="button" class="text-button" @click="select(selectedId)">
          {{ t('chart.retry') }}
        </button>
      </p>
      <template v-if="detail">
        <dl class="detail-grid">
          <div>
            <dt>{{ t('requests.status') }}</dt>
            <dd>{{ labels[detail.status] }}</dd>
          </div>
          <div>
            <dt>{{ t('requests.model') }}</dt>
            <dd>{{ detail.model ?? '–' }}</dd>
          </div>
          <div>
            <dt>{{ t('requests.origin') }}</dt>
            <dd>{{ detail.origin }}</dd>
          </div>
          <div>
            <dt>{{ t('requests.httpStatus') }}</dt>
            <dd>{{ detail.httpStatus ?? '–' }}</dd>
          </div>
          <div>
            <dt>{{ t('requests.endpoint') }}</dt>
            <dd>{{ detail.method }} {{ detail.endpoint }}</dd>
          </div>
          <div>
            <dt>{{ t('requests.errorCode') }}</dt>
            <dd>{{ detail.errorCode ?? '–' }}</dd>
          </div>
          <div>
            <dt>{{ t('requests.bytes') }}</dt>
            <dd>{{ formatBytes(detail.promptBytes) }} / {{ formatBytes(detail.responseBytes) }}</dd>
          </div>
          <div>
            <dt>{{ t('requests.totalTokens') }}</dt>
            <dd>{{ formatInteger(detail.totalTokens) }}</dd>
          </div>
          <div>
            <dt>{{ t('requests.started') }}</dt>
            <dd>{{ formatTimestamp(detail.startedAtUtc) }}</dd>
          </div>
          <div>
            <dt>{{ t('requests.firstToken') }}</dt>
            <dd>{{ formatMsAsSeconds(detail.ttftMs) }}</dd>
          </div>
          <div>
            <dt>{{ t('requests.totalDuration') }}</dt>
            <dd>{{ formatMsAsSeconds(detail.durationMs) }}</dd>
          </div>
        </dl>
        <h3>{{ t('requests.lifecycle') }}</h3>
        <ol class="lifecycle">
          <li v-for="event in detail.events" :key="event.sequence">
            <time :datetime="event.atUtc">{{ formatClock(event.atUtc) }}</time
            ><span>{{ eventLabels[event.eventType] ?? event.eventType }}</span>
          </li>
        </ol>
        <p v-if="detail.events.length === 0" class="section-caption">
          {{ t('requests.noEvents') }}
        </p>
      </template>
    </section>
  </section>
</template>
