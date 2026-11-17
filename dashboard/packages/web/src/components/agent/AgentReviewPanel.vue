<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from 'vue';
import type {
  AgentReview,
  AgentRunResult,
  AgentRunSnapshot,
  DurableTraceEvent,
} from '@observatory/contracts';
import { reduceAgentSnapshot } from '../../composables/useAgentCockpit.js';
import { collectAgentRunTrace } from '../../lib/api.js';
import { t } from '../../lib/i18n.js';
import MarkdownText from '../MarkdownText.vue';
import AgentTimeline from './AgentTimeline.vue';

const props = defineProps<{
  reviews: AgentReview[];
  result?: AgentRunResult;
  mayStart: boolean;
  reviewing: boolean;
  correcting: boolean;
  liveSnapshot?: AgentRunSnapshot;
}>();
const emit = defineEmits<{
  review: [input: { sourceRunId: string; resultRevision: string; instructions?: string }];
  correct: [input: { reviewId: string; findingIds: string[]; instructions?: string }];
}>();

const instructions = ref('');
const correctionNotes = reactive<Record<string, string>>({});
const selected = reactive<Record<string, boolean>>({});
const activitySnapshots = reactive<Record<string, AgentRunSnapshot>>({});
const activityLoading = reactive<Record<string, boolean>>({});
const activityFailed = reactive<Record<string, boolean>>({});
const openReviewId = ref<string>();
const activityRequests = new Map<string, number>();
let activityPoll: ReturnType<typeof setInterval> | undefined;
const hasActiveReview = computed(() =>
  props.reviews.some((review) => ['queued', 'starting', 'running'].includes(review.status))
);

function selectedIds(review: AgentReview): string[] {
  return review.findings.filter((finding) => selected[finding.id]).map((finding) => finding.id);
}

function startReview(): void {
  if (props.result === undefined) return;
  emit('review', {
    sourceRunId: props.result.runId,
    resultRevision: props.result.resultRevision,
    ...(instructions.value.trim() === '' ? {} : { instructions: instructions.value.trim() }),
  });
}

function startCorrection(review: AgentReview): void {
  const findingIds = selectedIds(review);
  if (findingIds.length === 0) return;
  const notes = correctionNotes[review.id]?.trim() ?? '';
  emit('correct', {
    reviewId: review.id,
    findingIds,
    ...(notes === '' ? {} : { instructions: notes }),
  });
}

function applyTrace(
  current: AgentRunSnapshot | undefined,
  events: DurableTraceEvent[]
): AgentRunSnapshot | undefined {
  let snapshot = current;
  for (const entry of events) {
    if (entry.event.operation === 'reset') snapshot = entry.event.snapshot;
    else if (snapshot !== undefined) snapshot = reduceAgentSnapshot(snapshot, entry.event);
  }
  return snapshot;
}

async function loadActivity(review: AgentReview, forcePersisted = false): Promise<void> {
  if (!forcePersisted && props.liveSnapshot?.runId === review.reviewerRunId) {
    activitySnapshots[review.id] = props.liveSnapshot;
    return;
  }
  if (activityLoading[review.id]) return;
  const request = (activityRequests.get(review.id) ?? 0) + 1;
  activityRequests.set(review.id, request);
  activityLoading[review.id] = true;
  activityFailed[review.id] = false;
  try {
    const current = activitySnapshots[review.id];
    const events = await collectAgentRunTrace(review.reviewerRunId, {
      afterSequence: current?.sequence ?? -1,
      failOnStalledCursor: true,
    });
    const next = applyTrace(current, events);
    if (activityRequests.get(review.id) === request && next !== undefined) {
      activitySnapshots[review.id] = next;
    }
  } catch {
    if (activityRequests.get(review.id) === request) activityFailed[review.id] = true;
  } finally {
    if (activityRequests.get(review.id) === request) activityLoading[review.id] = false;
  }
}

function refreshActivityPolling(): void {
  if (activityPoll !== undefined) clearInterval(activityPoll);
  activityPoll = undefined;
  const review = props.reviews.find((entry) => entry.id === openReviewId.value);
  if (review === undefined || !['queued', 'starting', 'running'].includes(review.status)) return;
  activityPoll = setInterval(() => void loadActivity(review, true), 1_200);
}

function toggleActivity(review: AgentReview): void {
  if (openReviewId.value === review.id) {
    openReviewId.value = undefined;
    refreshActivityPolling();
    return;
  }
  openReviewId.value = review.id;
  void loadActivity(review);
  refreshActivityPolling();
}

watch(
  () => props.liveSnapshot,
  (snapshot) => {
    if (snapshot?.runId === undefined) return;
    const review = props.reviews.find((entry) => entry.reviewerRunId === snapshot.runId);
    if (review === undefined) return;
    activitySnapshots[review.id] = snapshot;
    openReviewId.value = review.id;
  },
  { immediate: true }
);

watch(
  () => props.reviews.map((review) => `${review.id}:${review.status}`).join(','),
  () => {
    const latest = props.reviews[0];
    if (latest === undefined) {
      openReviewId.value = undefined;
      return;
    }
    if (
      openReviewId.value === undefined ||
      !props.reviews.some((review) => review.id === openReviewId.value)
    ) {
      openReviewId.value = latest.id;
    }
    const open = props.reviews.find((review) => review.id === openReviewId.value);
    if (open !== undefined) void loadActivity(open);
    refreshActivityPolling();
  },
  { immediate: true }
);

onUnmounted(() => {
  if (activityPoll !== undefined) clearInterval(activityPoll);
});
</script>

<template>
  <section class="review-workspace" role="tabpanel">
    <form v-if="result" class="panel review-launch" @submit.prevent="startReview">
      <div>
        <h3>{{ t('agent.independentReview') }}</h3>
        <p>
          {{ t('agent.reviewRevision') }}
          <code>{{ result.resultRevision.slice(0, 12) }}</code>
        </p>
      </div>
      <textarea
        v-model="instructions"
        rows="3"
        maxlength="16384"
        :placeholder="t('agent.reviewPlaceholder')"
      ></textarea>
      <button
        class="primary-button"
        type="submit"
        :disabled="reviewing || !mayStart || hasActiveReview"
      >
        {{ reviewing ? t('agent.reviewStarting') : t('agent.startReview') }}
      </button>
    </form>

    <p v-else class="panel review-empty">{{ t('agent.reviewNeedsResult') }}</p>

    <article v-for="review in reviews" :key="review.id" class="panel review-card">
      <header class="review-heading">
        <div>
          <h3>{{ t('agent.review') }}</h3>
          <code>{{ review.resultRevision.slice(0, 12) }}</code>
        </div>
        <span class="review-status" :class="review.status">
          {{
            ['queued', 'starting', 'running'].includes(review.status)
              ? t('agent.reviewRunning')
              : review.status === 'completed'
                ? t('agent.reviewCompleted')
                : t('agent.reviewFailed')
          }}
        </span>
        <span v-if="review.stale" class="review-stale">{{ t('agent.reviewStale') }}</span>
        <button
          class="text-button review-activity-toggle"
          type="button"
          @click="toggleActivity(review)"
        >
          {{
            openReviewId === review.id
              ? t('agent.hideReviewActivity')
              : t('agent.showReviewActivity')
          }}
        </button>
      </header>

      <div v-if="openReviewId === review.id" class="review-activity">
        <AgentTimeline
          :items="activitySnapshots[review.id]?.timeline ?? []"
          :loading="activityLoading[review.id] === true"
          :durable-run-status="review.status"
          :run-id="review.reviewerRunId"
        />
        <p v-if="activityFailed[review.id]" class="review-activity-error">
          {{ t('agent.reviewActivityUnavailable') }}
        </p>
      </div>

      <MarkdownText v-if="review.summary" :text="review.summary" />

      <p
        v-if="review.status === 'completed' && review.findings.length === 0"
        class="review-no-findings"
      >
        {{ t('agent.noReviewFindings') }}
      </p>

      <div v-if="review.findings.length" class="review-findings">
        <label v-for="finding in review.findings" :key="finding.id" class="review-finding">
          <input
            v-model="selected[finding.id]"
            type="checkbox"
            :disabled="review.stale || correcting"
          />
          <span class="finding-content">
            <span class="finding-title">
              <em :class="`severity-${finding.severity}`">{{ finding.severity }}</em>
              <strong>{{ finding.title }}</strong>
              <code v-if="finding.file">
                {{ finding.file }}{{ finding.line === undefined ? '' : `:${finding.line}` }}
              </code>
            </span>
            <MarkdownText :text="finding.reasoning" />
            <small v-if="finding.evidence">{{ finding.evidence }}</small>
          </span>
        </label>
      </div>

      <form
        v-if="review.status === 'completed' && review.findings.length && !review.stale"
        class="review-correction"
        @submit.prevent="startCorrection(review)"
      >
        <textarea
          v-model="correctionNotes[review.id]"
          rows="2"
          maxlength="16384"
          :placeholder="t('agent.correctionPlaceholder')"
        ></textarea>
        <button
          class="primary-button"
          type="submit"
          :disabled="correcting || !mayStart || selectedIds(review).length === 0"
        >
          {{ correcting ? t('agent.correctionStarting') : t('agent.fixSelected') }}
        </button>
      </form>
    </article>
  </section>
</template>
