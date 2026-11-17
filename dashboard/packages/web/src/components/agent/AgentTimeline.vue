<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import type { AgentTimelineImage, AgentTimelineItem, SubagentRun } from '@observatory/contracts';
import { agentConversations, conversationItems } from '../../lib/agent-conversations.js';
import { agentImageUrl } from '../../lib/api.js';
import { formatClock, formatMsAsSeconds } from '../../lib/format.js';
import { t } from '../../lib/i18n.js';
import { timelineStateLabel, timelineTitle } from '../../lib/labels.js';
import { timelineToolOutput } from '../../lib/timeline.js';
import { isTimelineNearEnd, newTimelineItemCount } from '../../lib/timeline.js';
import MarkdownText from '../MarkdownText.vue';

/**
 * The fully visible conversation trace of one run. Product rule: everything
 * stays directly visible — task text, steering, assistant text, thinking,
 * tool arguments, tool outputs, retries, compaction, notices, errors and
 * inline screenshots. No per-event collapsing, no partial boxes. The only
 * chrome is the follow control, which respects the reader's scroll position.
 */
const props = defineProps<{
  items: AgentTimelineItem[];
  /** True while a persisted task history is being loaded. */
  loading: boolean;
  /** Durable run status; frames error items of an interrupted run. */
  durableRunStatus?: string;
  /**
   * Live runs start at the newest event; historical views start where the
   * reader is and rely on the follow control instead of an end jump.
   */
  isLiveRun?: boolean;
  /** Run bound to the items; image sources are generated from it. */
  runId?: string;
  subagents?: SubagentRun[];
}>();

const selectedAgent = ref('main');
const conversations = computed(() => agentConversations(props.items, props.subagents));
const visibleItems = computed(() => conversationItems(props.items, selectedAgent.value));
watch(
  () => props.runId,
  () => {
    selectedAgent.value = 'main';
  }
);
watch(selectedAgent, () => {
  following.value = props.isLiveRun === true;
  unseenEvents.value = 0;
});

// Following is reader intent, not a consequence of a layout-induced scroll event.
const following = ref(true);
const unseenEvents = ref(0);
const timelineElement = ref<HTMLElement>();
const timelineContent = ref<HTMLElement>();
let lastScrollTop = 0;
let pinQueued = false;
let disposed = false;
let draggingScrollbar = false;
let scrollbarInputUntil = 0;
let touchY: number | undefined;
let resizeObserver: ResizeObserver | undefined;

async function pinToLatest(): Promise<void> {
  if (pinQueued || !following.value || disposed) return;
  pinQueued = true;
  await nextTick();
  pinQueued = false;
  // The reader may have scrolled up while Vue was updating the DOM.
  if (!following.value || disposed) return;
  const element = timelineElement.value;
  if (!element) return;
  element.scrollTo({ top: element.scrollHeight, behavior: 'instant' });
  lastScrollTop = element.scrollTop;
}

function scrollToLatest(): void {
  following.value = true;
  unseenEvents.value = 0;
  void pinToLatest();
}

function handleTimelineScroll(): void {
  const element = timelineElement.value;
  if (!element) return;
  const movedUp = element.scrollTop < lastScrollTop - 1;
  if ((draggingScrollbar || Date.now() < scrollbarInputUntil) && movedUp) {
    // Scrollbar input pauses follow. Layout/scroll anchoring alone never does.
    following.value = false;
  } else if (
    isTimelineNearEnd(element) &&
    (following.value || element.scrollTop > lastScrollTop + 1)
  ) {
    // A small upward gesture inside the near-end tolerance still means pause.
    following.value = true;
    unseenEvents.value = 0;
  }
  lastScrollTop = element.scrollTop;
}

function handleWheel(event: WheelEvent): void {
  if (event.deltaY < 0 && (timelineElement.value?.scrollTop ?? 0) > 0) following.value = false;
}
function handleKeydown(event: KeyboardEvent): void {
  if (
    ['ArrowUp', 'PageUp', 'Home'].includes(event.key) &&
    (timelineElement.value?.scrollTop ?? 0) > 0
  )
    following.value = false;
}

function handlePointerDown(event: PointerEvent): void {
  draggingScrollbar = event.pointerType !== 'touch';
}
function releasePointer(): void {
  // Native scrollbar scroll events can arrive just after pointerup.
  if (draggingScrollbar) scrollbarInputUntil = Date.now() + 300;
  draggingScrollbar = false;
}
function handleTouchStart(event: TouchEvent): void {
  touchY = event.touches[0]?.clientY;
}
function handleTouchMove(event: TouchEvent): void {
  const y = event.touches[0]?.clientY;
  if (
    y !== undefined &&
    touchY !== undefined &&
    y > touchY &&
    (timelineElement.value?.scrollTop ?? 0) > 0
  )
    following.value = false;
  touchY = y;
}
function handleTouchEnd(): void {
  touchY = undefined;
}

watch(
  () => visibleItems.value.length,
  (current, previous) => {
    if (!following.value) unseenEvents.value += newTimelineItemCount(previous, current);
    else void pinToLatest();
  }
);
watch(
  () => {
    const last = visibleItems.value.at(-1);
    return `${last?.id ?? ''}:${last?.text?.length ?? 0}:${last?.state ?? ''}`;
  },
  () => {
    void pinToLatest();
  }
);

onMounted(() => {
  window.addEventListener('pointerup', releasePointer);
  window.addEventListener('pointercancel', releasePointer);
  following.value = props.isLiveRun === true;
  if (typeof ResizeObserver !== 'undefined') {
    // Both streamed tool output and late Markdown/images can change earlier items.
    resizeObserver = new ResizeObserver(() => {
      void pinToLatest();
    });
    if (timelineContent.value) resizeObserver.observe(timelineContent.value);
    if (timelineElement.value) resizeObserver.observe(timelineElement.value);
  }
  if (following.value) void pinToLatest();
});
onUnmounted(() => {
  disposed = true;
  resizeObserver?.disconnect();
  window.removeEventListener('pointerup', releasePointer);
  window.removeEventListener('pointercancel', releasePointer);
});

// --- Inline image viewer -------------------------------------------------
const selectedImage = ref<AgentTimelineImage | null>(null);
const imageFailed = reactive<Record<string, boolean>>({});
const dialogRef = ref<HTMLDialogElement>();
let lastFocused: HTMLElement | null = null;

/** A loaded thumbnail changes the timeline height; keep the reader pinned. */
function handleImageLoaded(): void {
  if (following.value) void pinToLatest();
}

function openImage(image: AgentTimelineImage): void {
  lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  selectedImage.value = image;
  void nextTick(() => {
    const dialog = dialogRef.value;
    if (dialog === undefined || dialog === null) return;
    if (typeof dialog.showModal === 'function' && !dialog.open) dialog.showModal();
    else if (!dialog.hasAttribute('open')) dialog.setAttribute('open', '');
    dialog.focus();
  });
}

function closeImage(): void {
  const dialog = dialogRef.value;
  selectedImage.value = null;
  if (dialog !== undefined && dialog !== null) {
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else dialog.removeAttribute('open');
  }
  lastFocused?.focus();
  lastFocused = null;
}

function handleBackdropClick(event: MouseEvent): void {
  if (event.target === dialogRef.value) closeImage();
}

function handleDialogCancel(event: Event): void {
  // Route the native Escape/cancel through our own close so focus returns.
  event.preventDefault();
  closeImage();
}

function handleDialogKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeImage();
    return;
  }
  if (event.key !== 'Tab') return;
  // Minimal focus trap: the dialog is small (image + close button), so
  // cycling the focusable elements keeps keyboard/touch parity without a
  // focus-trap library.
  const dialog = dialogRef.value;
  if (dialog === undefined || dialog === null) return;
  const focusable = Array.from(
    dialog.querySelectorAll<HTMLElement>('button, [href], img[tabindex]')
  ).filter((element) => !element.hasAttribute('disabled'));
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === dialog)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function imageSource(image: AgentTimelineImage): string {
  return agentImageUrl(image.runId, image.id);
}
</script>

<template>
  <section class="panel timeline-panel">
    <nav
      v-if="conversations.length"
      class="agent-conversation-tabs"
      :aria-label="t('agent.agentChats')"
    >
      <button
        type="button"
        :aria-pressed="selectedAgent === 'main'"
        @click="selectedAgent = 'main'"
      >
        {{ t('agent.mainAgent') }}
      </button>
      <button
        v-for="agent in conversations"
        :key="agent.id"
        type="button"
        :aria-pressed="selectedAgent === agent.id"
        @click="selectedAgent = agent.id"
      >
        {{ agent.name }}
        <small v-if="agent.status">{{ t(`agent.child.${agent.status}`) }}</small>
      </button>
    </nav>
    <div
      ref="timelineElement"
      class="agent-timeline"
      aria-live="off"
      :class="{ following }"
      tabindex="0"
      @scroll.passive="handleTimelineScroll"
      @wheel.passive="handleWheel"
      @keydown="handleKeydown"
      @pointerdown="handlePointerDown"
      @touchstart.passive="handleTouchStart"
      @touchmove.passive="handleTouchMove"
      @touchend.passive="handleTouchEnd"
      @touchcancel.passive="handleTouchEnd"
    >
      <div ref="timelineContent" class="timeline-content">
        <div v-if="!visibleItems.length" class="timeline-empty">
          {{ loading ? t('agent.historyLoading') : t('agent.historyEmpty') }}
        </div>
        <article
          v-for="item in visibleItems"
          :key="item.id"
          class="timeline-item"
          :class="[item.kind, item.state, { 'tool-call': item.kind === 'tool' }]"
        >
          <header>
            <strong>{{ timelineTitle(item) }}</strong>
            <span v-if="item.state" class="timeline-state">{{
              timelineStateLabel(item.state, durableRunStatus)
            }}</span>
            <span v-if="item.durationMs !== undefined" class="timeline-state">
              {{ formatMsAsSeconds(item.durationMs) }}
            </span>
            <span v-if="item.argumentsTruncated || item.outputTruncated" class="timeline-state">
              {{ t('agent.truncated') }}
            </span>
            <time :datetime="item.at">{{ formatClock(item.at) }}</time>
          </header>

          <div
            v-if="
              item.kind !== 'tool' &&
              item.images !== undefined &&
              item.images.length > 0 &&
              runId !== undefined
            "
            class="timeline-images"
          >
            <button
              v-for="(image, imageIndex) in item.images"
              :key="`${image.id}:${imageIndex}`"
              type="button"
              class="image-thumb"
              :class="{ 'image-thumb-error': imageFailed[image.id] === true }"
              :aria-label="t('agent.imageOpen', { label: image.label ?? t('agent.imageAlt') })"
              @click="openImage(image)"
            >
              <img
                v-if="!imageFailed[image.id]"
                :src="imageSource(image)"
                :alt="image.label ?? t('agent.imageAlt')"
                loading="lazy"
                decoding="async"
                @load="handleImageLoaded"
                @error="imageFailed[image.id] = true"
              />
              <span v-else class="image-thumb-fallback">{{ t('agent.imageError') }}</span>
            </button>
            <span class="image-note">{{
              t(item.kind === 'task' ? 'agent.imageReference' : 'agent.imageReturned')
            }}</span>
          </div>

          <!-- Every block of the trace stays directly visible -->
          <p
            v-if="(item.kind === 'task' || item.kind === 'steering') && item.text"
            class="user-message"
            v-text="item.text"
          ></p>
          <MarkdownText v-else-if="item.kind === 'assistant' && item.text" :text="item.text" />
          <p
            v-else-if="item.kind === 'thinking' && item.text"
            class="timeline-reasoning-text"
            v-text="item.text"
          ></p>
          <div v-else-if="item.kind === 'tool'" class="tool-payload">
            <section class="tool-payload-card" :aria-label="t('agent.toolArguments')">
              <span class="timeline-block-label">{{ t('agent.toolArguments') }}</span>
              <pre
                v-if="item.argumentsText"
                class="timeline-text"
                v-text="item.argumentsText"
              ></pre>
              <p v-else class="tool-payload-empty">{{ t('agent.noArguments') }}</p>
            </section>
            <section class="tool-payload-card" :aria-label="t('agent.toolOutput')">
              <span class="timeline-block-label">{{ t('agent.toolOutput') }}</span>
              <div
                v-if="item.images !== undefined && item.images.length > 0 && runId !== undefined"
                class="timeline-images"
              >
                <button
                  v-for="(image, imageIndex) in item.images"
                  :key="`${image.id}:${imageIndex}`"
                  type="button"
                  class="image-thumb"
                  :class="{ 'image-thumb-error': imageFailed[image.id] === true }"
                  :aria-label="t('agent.imageOpen', { label: image.label ?? t('agent.imageAlt') })"
                  @click="openImage(image)"
                >
                  <img
                    v-if="!imageFailed[image.id]"
                    :src="imageSource(image)"
                    :alt="image.label ?? t('agent.imageAlt')"
                    loading="lazy"
                    decoding="async"
                    @load="handleImageLoaded"
                    @error="imageFailed[image.id] = true"
                  />
                  <span v-else class="image-thumb-fallback">{{ t('agent.imageError') }}</span>
                </button>
                <span class="image-note">{{ t('agent.imageReturned') }}</span>
              </div>

              <pre
                v-if="timelineToolOutput(item)"
                class="timeline-text"
                v-text="timelineToolOutput(item)"
              ></pre>
              <p v-else-if="item.state === 'error'" class="tool-payload-empty">
                {{ t('agent.toolNotFinished') }}
              </p>
              <p v-else-if="!item.images?.length" class="tool-payload-empty">
                {{ t('agent.outputPending') }}
              </p>
            </section>
          </div>
          <pre v-else-if="item.text" class="timeline-text timeline-inline-text">{{
            item.text
          }}</pre>
        </article>
      </div>
    </div>
    <button v-if="!following" class="follow-button" type="button" @click="scrollToLatest">
      {{
        unseenEvents > 0 ? t('agent.follow', { count: unseenEvents }) : t('agent.scrollToBottom')
      }}
    </button>

    <!-- Responsive full-size image viewer -->
    <Teleport to="body">
      <dialog
        v-if="selectedImage !== null"
        ref="dialogRef"
        class="image-dialog"
        aria-modal="true"
        :aria-label="selectedImage.label ?? t('agent.imageAlt')"
        @cancel="handleDialogCancel"
        @click="handleBackdropClick"
        @keydown="handleDialogKeydown"
      >
        <figure class="image-dialog-figure">
          <img
            :src="imageSource(selectedImage)"
            :alt="selectedImage.label ?? t('agent.imageAlt')"
            decoding="async"
            @error="imageFailed[selectedImage.id] = true"
          />
          <span v-if="imageFailed[selectedImage.id]" class="image-dialog-error">
            {{ t('agent.imageError') }}
          </span>
          <figcaption class="image-dialog-caption">
            <span>{{ selectedImage.label ?? t('agent.imageAlt') }}</span>
            <span>{{
              t('agent.imageDimensions', {
                width: selectedImage.width,
                height: selectedImage.height,
              })
            }}</span>
          </figcaption>
        </figure>
        <button
          type="button"
          class="image-dialog-close"
          :aria-label="t('agent.imageClose')"
          @click="closeImage"
        >
          ✕
        </button>
      </dialog>
    </Teleport>
  </section>
</template>
