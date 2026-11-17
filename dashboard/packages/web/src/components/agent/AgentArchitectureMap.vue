<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type {
  AgentProject,
  ArchitectureNode,
  ArchitectureTarget,
  DurableTaskSummary,
  ProjectArchitecture,
} from '@observatory/contracts';
import type { AgentCockpitState } from '../../composables/useAgentCockpit.js';
import { useAppRoute } from '../../composables/useAppRoute.js';
import { fetchProjectArchitecture } from '../../lib/api.js';
import {
  architectureTrail,
  mapTaskHref,
  targetForNode,
  tasksAtNode,
} from '../../lib/architecture.js';
import { readAgentDraft, writeAgentDraft } from '../../lib/drafts.js';
import { prepareInputImage } from '../../lib/input-images.js';
import { locale, t } from '../../lib/i18n.js';
import { taskStatusLabel } from '../../lib/labels.js';
import { createUuid } from '../../lib/uuid.js';
import AppDialog from '../AppDialog.vue';
import AgentDictation from './AgentDictation.vue';
import AgentAppPanel from './AgentAppPanel.vue';

const props = defineProps<{
  project: AgentProject;
  tasks: DurableTaskSummary[];
  cockpit: AgentCockpitState;
}>();
const { appRoute, navigateTo } = useAppRoute();
const canvas = ref<HTMLElement>();
const focusCard = ref<HTMLElement>();
const connections = ref<string[]>([]);
let observer: ResizeObserver | undefined;
let frame: number | undefined;
function scheduleConnections(): void {
  if (frame !== undefined) cancelAnimationFrame(frame);
  frame = requestAnimationFrame(() => {
    frame = undefined;
    if (!canvas.value || !focusCard.value) return;
    const bounds = canvas.value.getBoundingClientRect();
    const origin = focusCard.value.getBoundingClientRect();
    const x = origin.left + origin.width / 2 - bounds.left;
    const y = origin.bottom - bounds.top;
    connections.value = [...canvas.value.querySelectorAll('.map-area')].map((element) => {
      const rect = element.getBoundingClientRect();
      const endX = rect.left + rect.width / 2 - bounds.left;
      const endY = rect.top - bounds.top;
      return `M ${x} ${y} V ${endY - 10} H ${endX} V ${endY}`;
    });
  });
}
onMounted(() => {
  if (typeof ResizeObserver !== 'undefined') observer = new ResizeObserver(scheduleConnections);
  if (canvas.value) observer?.observe(canvas.value);
});
watch([canvas, focusCard], async () => {
  observer?.disconnect();
  if (canvas.value) observer?.observe(canvas.value);
  await nextTick();
  scheduleConnections();
});

const map = ref<ProjectArchitecture>();
const loading = ref(false);
const error = ref('');
const focused = ref(false);
const mode = ref<'map' | 'nested'>('map');
try {
  if (localStorage.getItem('observatory.map.layout') === 'nested') mode.value = 'nested';
} catch {
  /* private browsing */
}
watch(mode, (value) => {
  try {
    localStorage.setItem('observatory.map.layout', value);
  } catch {
    /* best effort */
  }
});
let generation = 0;
const current = computed(
  () => map.value?.nodes.find((entry) => entry.id === appRoute.nodeId) ?? map.value?.nodes[0]
);
const children = computed(
  () => map.value?.nodes.filter((entry) => entry.parentId === current.value?.id) ?? []
);
const trail = computed(() =>
  map.value && current.value ? architectureTrail(map.value, current.value) : []
);
const pinned = computed(() =>
  map.value && current.value ? tasksAtNode(map.value, current.value, props.tasks) : []
);
watch([children, mode], async () => {
  await nextTick();
  scheduleConnections();
});
const staleNode = computed(
  () =>
    map.value && appRoute.nodeId && !map.value.nodes.some((entry) => entry.id === appRoute.nodeId)
);
const canStart = computed(() => props.cockpit.snapshot.value?.enabled === true);
const point = ref<ArchitectureTarget['point']>();
const screenPath = computed(() =>
  map.value?.kind === 'curated' && current.value?.screen &&
  Object.keys(import.meta.glob('/public/workspace/*.png')).includes(
    `/public/workspace/observatory-${current.value.screen}.png`
  )
    ? `/workspace/observatory-${current.value.screen}.png`
    : undefined
);
const dialogOpen = ref(false);
watch(
  () => current.value?.id,
  () => {
    dialogOpen.value = false;
  }
);
const message = ref('');
const dictating = ref(false);
const starting = ref(false);
const startError = ref('');
const requestKey = ref(createUuid());
const draftKey = computed(() => `map:${props.project.id}:${current.value?.id ?? 'root'}`);
watch(
  draftKey,
  (key) => {
    message.value = readAgentDraft(key, 'continue') ?? '';
    point.value = undefined;
  },
  { immediate: true }
);
watch(message, (value) => {
  writeAgentDraft(draftKey.value, 'continue', value);
  requestKey.value = createUuid();
});
watch(point, () => {
  requestKey.value = createUuid();
});
async function load(): Promise<void> {
  const request = ++generation;
  loading.value = true;
  error.value = '';
  try {
    const value = await fetchProjectArchitecture(props.project.id);
    if (request === generation) map.value = value;
  } catch {
    if (request === generation) error.value = t('map.unavailable');
  } finally {
    if (request === generation) loading.value = false;
  }
}
watch(
  () => props.project.id,
  () => {
    map.value = undefined;
    void load();
  },
  { immediate: true }
);
onUnmounted(() => {
  generation++;
  observer?.disconnect();
  if (frame !== undefined) cancelAnimationFrame(frame);
});
function openNode(entry: ArchitectureNode): void {
  navigateTo('projects', undefined, props.project.id, entry.id);
}
function countTasks(entry: ArchitectureNode): number {
  return map.value ? tasksAtNode(map.value, entry, props.tasks).length : 0;
}
function grandchildren(entry: ArchitectureNode): ArchitectureNode[] {
  return map.value?.nodes.filter((child) => child.parentId === entry.id) ?? [];
}
function pin(event: MouseEvent): void {
  const image = (event.currentTarget as HTMLElement).querySelector('img');
  if (!image) return;
  const rect = image.getBoundingClientRect();
  point.value =
    event.detail === 0
      ? { x: 0.5, y: 0.5 }
      : {
          x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
          y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
        };
}
function openDialog(): void {
  startError.value = '';
  dialogOpen.value = true;
}
async function submit(): Promise<void> {
  if (
    !map.value ||
    !current.value ||
    !message.value.trim() ||
    starting.value ||
    !canStart.value ||
    dictating.value
  )
    return;
  starting.value = true;
  startError.value = '';
  const selected = current.value;
  const submittedDraftKey = draftKey.value;
  const lifetime = generation;
  const target = targetForNode(map.value, selected, locale.value, point.value);
  try {
    // A screen marker always travels with the exact image shown to the user.
    const images = [];
    if (point.value && screenPath.value) {
      const response = await fetch(screenPath.value);
      if (!response.ok) throw new Error(t('agent.images.invalid'));
      images.push(
        await prepareInputImage(
          new File([await response.blob()], `Observatory-${selected.screen}-reference.png`, {
            type: 'image/png',
          })
        )
      );
    }
    const ok = await props.cockpit.start({
      projectId: props.project.id,
      task: message.value.trim(),
      architectureTarget: target,
      idempotencyKey: requestKey.value,
      ...(images.length ? { images } : {}),
    });
    if (!ok) {
      startError.value = props.cockpit.error.value || t('map.error');
      return;
    }
    writeAgentDraft(submittedDraftKey, 'continue', '');
    // Browser Back may leave this area while the runner is accepting the task.
    if (
      lifetime !== generation ||
      current.value?.id !== selected.id ||
      appRoute.page !== 'projects' ||
      appRoute.projectId !== props.project.id
    )
      return;
    message.value = '';
    point.value = undefined;
    dialogOpen.value = false;
    const taskId = props.cockpit.selectedTaskId.value;
    if (taskId) navigateTo('agent', taskId);
    else await props.cockpit.refreshTasks();
  } catch (cause) {
    startError.value = cause instanceof Error ? cause.message : t('map.error');
  } finally {
    starting.value = false;
  }
}
</script>

<template>
  <section class="architecture-workspace" :aria-label="t('map.title')">
    <p v-if="loading" role="status" class="map-notice">{{ t('map.loading') }}</p>
    <div v-else-if="error" class="map-notice" role="alert">
      <p>{{ error }}</p>
      <button type="button" @click="load">{{ t('map.retry') }}</button>
    </div>
    <template v-else-if="map && current">
      <div class="map-command-bar">
        <nav class="map-breadcrumbs" :aria-label="t('map.title')">
          <template v-for="(entry, index) in trail" :key="entry.id">
            <span v-if="index" aria-hidden="true">/</span>
            <button
              type="button"
              :aria-current="entry.id === current.id ? 'location' : undefined"
              @click="openNode(entry)"
            >
              {{ entry.label[locale] }}
            </button>
          </template>
        </nav>
        <div class="map-layout-switch" role="group" :aria-label="t('map.mode')">
          <button type="button" :aria-pressed="mode === 'map'" @click="mode = 'map'">
            {{ t('map.landscape') }}
          </button>
          <button type="button" :aria-pressed="mode === 'nested'" @click="mode = 'nested'">
            {{ t('map.nested') }}
          </button>
        </div>
      </div>
      <p v-if="staleNode" class="map-notice" role="status">{{ t('map.staleNode') }}</p>
      <div class="map-legend">
        <span class="legend-focus">● {{ t('map.legendFocus') }}</span
        ><span>↳ {{ t('map.legendChildren') }}</span
        ><span>● {{ t('map.legendTasks') }}</span
        ><button class="text-button" :aria-pressed="focused" @click="focused = !focused">
          {{ t(focused ? 'map.showContext' : 'map.focusArea') }}
        </button>
      </div>
      <div class="map-layout" :class="{ 'map-focused': focused }">
        <div
          ref="canvas"
          class="map-canvas"
          :class="[`layout-${mode}`, `area-${trail[1]?.id ?? 'root'}`]"
        >
          <svg v-if="mode === 'map'" class="map-connections" aria-hidden="true">
            <path v-for="(path, index) in connections" :key="index" :d="path" />
          </svg>
          <div class="map-canvas-caption">
            <span>{{ t(map.kind === 'curated' ? 'map.curated' : 'map.directories') }}</span
            ><code>{{ map.revision.slice(0, 8) }}</code>
          </div>
          <header ref="focusCard" class="map-focus">
            <span class="map-focus-mark" aria-hidden="true">{{
              current.id === 'root' ? '◈' : '◎'
            }}</span>
            <div>
              <h3>{{ current.label[locale] }}</h3>
              <p>{{ current.description[locale] }}</p>
            </div>
          </header>
          <div v-if="children.length" class="map-branches">
            <article
              v-for="entry in children"
              :key="entry.id"
              class="map-area"
              :class="`area-${trail[1]?.id ?? entry.id}`"
            >
              <button class="map-node" type="button" :data-node="entry.id" @click="openNode(entry)">
                <span class="map-node-eyebrow"
                  >{{ t('map.areas', { count: grandchildren(entry).length }) }}
                  <span aria-hidden="true">↗</span></span
                >
                <strong>{{ entry.label[locale] }}</strong
                ><span class="map-node-description">{{ entry.description[locale] }}</span>
                <span class="map-node-foot"
                  >{{ t('map.files', { count: entry.sourcePaths.length })
                  }}<span v-if="countTasks(entry)" class="map-task-count"
                    >● {{ countTasks(entry) }}</span
                  ></span
                >
              </button>
              <div
                v-if="mode === 'nested' && grandchildren(entry).length"
                class="map-nested-children"
              >
                <button
                  v-for="child in grandchildren(entry)"
                  :key="child.id"
                  type="button"
                  :data-node="child.id"
                  @click="openNode(child)"
                >
                  {{ child.label[locale] }} <span aria-hidden="true">↗</span>
                </button>
              </div>
            </article>
          </div>
          <div v-else class="map-leaf">
            <span class="map-leaf-symbol" aria-hidden="true">⌘</span>
            <p>{{ t('map.noChildren') }}</p>
            <ul class="map-leaf-files">
              <li v-for="path in current.sourcePaths" :key="path">
                <span aria-hidden="true">↳</span><code>{{ path }}</code>
              </li>
            </ul>
            <button type="button" class="primary-button" @click="openDialog">
              {{ t('map.newTask') }}
            </button>
          </div>
          <footer class="map-canvas-footer">
            <span>{{ props.project.targetBranch }}</span
            ><button type="button" class="text-button" :disabled="loading" @click="load">
              ↻ {{ t('map.retry') }}
            </button>
          </footer>
        </div>
        <aside v-if="!focused" class="map-inspector" :aria-label="t('map.context')">
          <div class="map-inspector-heading">
            <div>
              <span class="map-eyebrow">{{ t('map.context') }}</span>
              <h3>{{ current.label[locale] }}</h3>
            </div>
            <button type="button" class="primary-button" @click="openDialog">
              ＋ {{ t('map.newTask') }}
            </button>
          </div>
          <template v-if="screenPath">
            <p class="map-eyebrow">{{ t('map.screen') }}</p>
            <button type="button" class="map-screen" :aria-label="t('map.screenHint')" @click="pin">
              <img :src="screenPath" :alt="t('map.coverAlt')" />
              <span
                v-if="point"
                class="map-screen-pin"
                :style="{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }"
                aria-hidden="true"
                >＋</span
              >
            </button>
            <p class="map-screen-help">
              {{
                point
                  ? t('map.point', { x: Math.round(point.x * 100), y: Math.round(point.y * 100) })
                  : t('map.screenHint')
              }}
            </p>
            <button v-if="point" type="button" class="text-button" @click="point = undefined">
              {{ t('map.clearPoint') }}
            </button>
            <p class="map-screen-help">
              {{ locale === 'de' ? 'Schematische Beispielansicht' : 'Illustrative example layout' }}
            </p>
          </template>
          <a
            v-if="props.project.releaseTarget === 'observatory'"
            class="map-preview-link"
            href="/#/overview"
            target="_blank"
            rel="noopener noreferrer"
            >{{ t('map.preview') }} ↗</a
          >
          <AgentAppPanel
            v-if="props.project.appCapable"
            compact
            :project-id="props.project.id"
            :name="props.project.name"
          />
          <h4>{{ t('map.source') }}</h4>
          <ul class="map-sources">
            <li v-for="path in current.sourcePaths" :key="path">
              <code :title="path">{{ path }}</code>
            </li>
          </ul>
          <p v-if="!current.sourcePaths.length" class="map-empty">{{ t('map.noSource') }}</p>
          <h4>
            {{ t('map.tasks') }} <span>{{ pinned.length }}</span>
          </h4>
          <ul v-if="pinned.length" class="map-pinned-tasks">
            <li v-for="task in pinned" :key="task.id">
              <a :href="mapTaskHref(task.id)" class="map-task-link"
                ><span>{{ task.title }}</span
                ><small :class="`status-${task.latestRun.status}`">{{
                  taskStatusLabel(task.latestRun.status)
                }}</small></a
              >
              <span class="map-task-area">{{ task.architectureTarget?.label }}</span>
              <p v-if="task.architectureTarget?.revision !== map.revision" class="map-task-area">
                {{ t('map.stale') }}
              </p>
              <a
                v-if="task.latestRun.resultRevision"
                :href="mapTaskHref(task.id, 'changes')"
                class="map-review-link"
                >{{ t('map.review') }} →</a
              >
            </li>
          </ul>
          <p v-else class="map-empty">{{ t('map.noTasks') }}</p>
        </aside>
      </div>
      <AppDialog
        v-if="dialogOpen"
        :busy="starting"
        :title="`${t('map.newTask')} · ${current.label[locale]}`"
        @close="!starting && (dialogOpen = false)"
      >
        <form class="map-task-form" @submit.prevent="submit">
          <p class="map-task-trail">
            {{ trail.map((entry) => entry.label[locale]).join(' / ') }} ·
            {{ map.revision.slice(0, 8) }}
          </p>
          <p v-if="point">
            {{ t('map.point', { x: Math.round(point.x * 100), y: Math.round(point.y * 100) }) }}
          </p>
          <label for="map-task-message">{{ t('map.taskLabel') }}</label>
          <textarea
            id="map-task-message"
            v-model="message"
            required
            maxlength="48000"
            rows="6"
            :placeholder="t('map.taskPlaceholder')"
            :disabled="starting"
          ></textarea>
          <AgentDictation
            compact
            :disabled="starting"
            @busy="dictating = $event"
            @transcript="message = [message.trimEnd(), $event].filter(Boolean).join(' ')"
          />
          <p v-if="!canStart" role="status">{{ t('map.disabled') }}</p>
          <p v-if="startError" class="error-text" role="alert">{{ startError }}</p>
          <p class="map-screen-help">{{ t('map.draft') }}</p>
          <button
            class="primary-button"
            type="submit"
            :disabled="starting || dictating || !canStart || !message.trim()"
          >
            {{ starting ? t('map.starting') : t('map.start') }} ↗
          </button>
        </form>
      </AppDialog>
    </template>
  </section>
</template>

<style scoped>
.map-legend {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--dim);
  margin-bottom: 8px;
}
.map-legend .legend-focus {
  color: var(--accent);
}
.map-legend button {
  margin-left: auto;
  font-size: 11px;
  min-height: 36px;
}
.map-layout.map-focused {
  grid-template-columns: minmax(0, 1fr);
}
.map-focused .map-branches {
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
}
.map-focus {
  outline: 1px solid var(--accent);
  outline-offset: 3px;
}
.map-node-eyebrow {
  letter-spacing: 0.04em;
}

.architecture-workspace {
  min-width: 0;
}
.map-command-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.map-breadcrumbs {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 4px;
  min-width: 0;
}
.map-breadcrumbs button {
  border: 0;
  background: transparent;
  color: var(--dim);
  padding: 8px;
  min-height: 44px;
  overflow-wrap: anywhere;
}
.map-breadcrumbs button[aria-current] {
  color: var(--text);
}
.map-breadcrumbs > span {
  color: var(--dim);
}
.map-layout-switch {
  display: flex;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--panel);
}
.map-layout-switch button {
  min-height: 40px;
  padding: 7px 12px;
  background: transparent;
  border: 0;
  border-radius: 7px;
  font-size: 12px;
  color: var(--dim);
}
.map-layout-switch button[aria-pressed='true'] {
  background: #284238;
  color: #c6ead9;
}
.map-layout {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(250px, 310px);
  gap: 14px;
  align-items: start;
}
.map-canvas {
  --area: #80bda3;
  position: relative;
  isolation: isolate;
  min-width: 0;
  min-height: 560px;
  padding: 20px;
  background:
    radial-gradient(circle, #35413f 1px, transparent 1px) 0 0/22px 22px,
    #101a1e;
  border: 1px solid #31413e;
  border-radius: 16px;
  display: flex;
  flex-direction: column;
}
.map-connections {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 0;
}
.map-connections path {
  stroke: #567265;
  stroke-width: 1;
  fill: none;
}
.map-canvas-caption {
  display: flex;
  gap: 10px;
  justify-content: space-between;
  font-size: 11px;
  color: #a4b8b1;
}
.map-canvas-caption code {
  white-space: nowrap;
  color: #a4b8b1;
}
.map-focus {
  position: relative;
  display: flex;
  align-items: center;
  gap: 14px;
  margin: 28px auto 24px;
  padding: 16px 20px;
  max-width: 100%;
  border: 1px solid #4c6a5e;
  border-radius: 12px;
  background: #192c26;
  box-shadow: 0 10px 30px #0003;
}
.map-focus h3 {
  margin: 0 0 5px;
  font-size: 20px;
}
.map-focus p {
  margin: 0;
  color: #b0c5bd;
  font-size: 12px;
  line-height: 1.5;
}
.map-focus-mark {
  color: #9cd4b8;
  font-size: 28px;
}
.map-branches {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 20px 16px;
  position: relative;
}

.map-area {
  --area: #9dabbc;
  min-width: 0;
  position: relative;
  border: 1px solid color-mix(in srgb, var(--area) 40%, #263339);
  border-radius: 12px;
  background: #172329;
  box-shadow: 0 8px 24px #0002;
}
.area-interface {
  --area: #8bc6ab;
}
.area-agents {
  --area: #b9a2df;
}
.area-models {
  --area: #dfbf7d;
}
.area-operations {
  --area: #87bad8;
}
.map-node {
  color: var(--text);
  width: 100%;
  height: 100%;
  display: flex;
  align-items: stretch;
  text-align: left;
  flex-direction: column;
  padding: 16px;
  gap: 8px;
  border: 0;
  border-radius: 11px;
  background: linear-gradient(
    140deg,
    color-mix(in srgb, var(--area) 10%, transparent),
    transparent
  );
  min-width: 0;
  transition:
    transform 0.15s,
    border-color 0.15s;
}
.map-node:hover {
  transform: translateY(-2px);
  background: color-mix(in srgb, var(--area) 14%, #172329);
}
.map-node:focus-visible,
.map-nested-children button:focus-visible {
  outline: 2px solid var(--area);
  outline-offset: 3px;
}
.map-node strong {
  font-size: 18px;
  line-height: 1.35;
  color: var(--area);
  overflow-wrap: anywhere;
}
.map-node-eyebrow,
.map-node-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  color: #b5c0c5;
}
.map-node-eyebrow span {
  font-size: 18px;
  color: var(--area);
}
.map-node-description {
  font-size: 12px;
  line-height: 1.6;
  color: #c0c9ce;
  flex: 1;
}
.map-node-foot {
  margin-top: 8px;
}
.map-task-count {
  color: var(--area);
}
.map-nested-children {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin: 0 10px 10px;
}
.map-nested-children button {
  border: 1px solid #ffffff15;
  border-radius: 6px;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  text-align: left;
  font-size: 12px;
  min-height: 44px;
  padding: 8px 10px;
  background: #0b141a77;
  color: #d5dfdd;
}
.layout-nested .map-area {
  display: flex;
  flex-direction: column;
}
.layout-nested .map-node {
  height: auto;
  flex: 1;
}
.map-canvas-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: auto;
  padding-top: 24px;
  color: #91a59c;
  font-size: 11px;
}
.map-canvas-footer button {
  font-size: 11px;
  min-height: 44px;
}
.map-inspector {
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--panel);
  padding: 16px;
}
.map-inspector-heading {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 18px;
}
.map-eyebrow {
  font-size: 10px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--dim);
}
.map-inspector h3 {
  font-size: 17px;
  margin: 5px 0 0;
}
.map-inspector .primary-button {
  font-size: 12px;
  min-height: 44px;
  padding: 9px 12px;
}
.map-inspector h4 {
  font-size: 12px;
  color: #bac8c1;
  margin: 24px 0 10px;
  display: flex;
  gap: 10px;
}
.map-inspector h4 > span {
  color: var(--dim);
}
.map-sources {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.map-sources code {
  display: block;
  font-size: 10px;
  line-height: 1.6;
  overflow-wrap: anywhere;
  color: #b4c0c6;
}
.map-empty {
  font-size: 12px;
  line-height: 1.6;
  color: var(--dim);
}
.map-pinned-tasks {
  list-style: none;
  margin: 0;
  padding: 0;
}
.map-pinned-tasks li {
  border-top: 1px solid var(--border);
  padding: 12px 0;
}
.map-task-link {
  color: var(--text);
  text-decoration: none;
  display: flex;
  flex-direction: column;
  gap: 7px;
  font-size: 13px;
  overflow-wrap: anywhere;
}
.map-task-link small {
  font-size: 11px;
  color: #a8cbb9;
}
.map-task-area {
  font-size: 10px;
  line-height: 1.6;
  color: var(--dim);
  margin: 4px 0;
}
.map-review-link,
.map-preview-link {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  color: #9fd5ba;
  font-size: 12px;
  text-decoration: none;
}
.map-screen {
  display: block;
  position: relative;
  width: 100%;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #0c141c;
  cursor: crosshair;
  overflow: hidden;
}
.map-screen img {
  display: block;
  width: 100%;
  height: auto;
}
.map-screen-pin {
  position: absolute;
  transform: translate(-50%, -50%);
  border: 2px solid #fff;
  border-radius: 100%;
  width: 26px;
  height: 26px;
  background: #ad5b32;
  display: grid;
  place-items: center;
  color: #fff;
  box-shadow: 0 0 0 4px #ad5b3266;
}
.map-screen-help {
  font-size: 10px;
  line-height: 1.6;
  color: var(--dim);
  margin: 8px 0;
}
.map-leaf {
  padding: 25px 0;
  text-align: center;
}
.map-leaf-symbol {
  display: block;
  font-size: 38px;
  color: var(--area);
}
.map-leaf p {
  color: #b1c3bc;
  font-size: 13px;
}
.map-leaf-files {
  list-style: none;
  text-align: left;
  margin: 25px 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.map-leaf-files li {
  display: flex;
  gap: 10px;
  align-items: start;
  min-width: 0;
  color: #abc4b5;
}
.map-leaf-files code {
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.map-task-form {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 12px;
}
.map-task-form textarea {
  resize: vertical;
  min-height: 150px;
}
.map-task-trail {
  margin: 0;
  font-size: 12px;
  color: var(--dim);
  overflow-wrap: anywhere;
}
.map-task-form label {
  font-size: 14px;
}
.map-task-form > .primary-button {
  align-self: flex-end;
  min-height: 46px;
}
.map-notice {
  padding: 16px;
  color: var(--dim);
}
@media (max-width: 1100px) {
  .map-layout {
    grid-template-columns: minmax(0, 1fr) 260px;
  }
  .map-canvas {
    padding: 16px;
  }
  .map-node {
    padding: 13px;
  }
  .map-node strong {
    font-size: 16px;
  }
}
@media (max-width: 760px) {
  .map-layout {
    grid-template-columns: minmax(0, 1fr);
  }
  .map-canvas {
    min-height: 470px;
  }
  .map-inspector {
    display: block;
  }
  .map-inspector-heading {
    margin-bottom: 12px;
  }
  .map-screen {
    max-width: 420px;
  }
  .map-command-bar {
    gap: 4px;
  }
  .map-layout-switch {
    margin-left: auto;
  }
  .map-focus {
    margin-top: 22px;
  }
  .map-branches {
    gap: 12px;
  }
  .map-node-description {
    font-size: 11px;
  }
  .map-node strong {
    font-size: 16px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .map-node {
    transition: none;
  }
}
</style>
