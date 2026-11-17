<script setup lang="ts">
import { useWorkspaceSplit } from '../composables/useWorkspaceSplit.js';
import { readTaskView, writeTaskView } from '../lib/task-view-state.js';
import { engineMode } from '../composables/useEngineMode.js';
import { computed, onBeforeUnmount, onMounted, onUnmounted, ref, watch } from 'vue';
import type { AgentInputImage, AgentRunResult, AgentRunSnapshot } from '@observatory/contracts';
import { reduceAgentSnapshot, useAgentCockpit } from '../composables/useAgentCockpit.js';
import { useAppRoute } from '../composables/useAppRoute.js';
import {
  collectAgentRunTrace,
  fetchAgentRunResult,
  HealthFetchError,
  regenerateAgentTaskTitle,
  registerAgentProject,
  createAgentProject,
} from '../lib/api.js';
import { formatRuntimeClock, formatShortDateTime } from '../lib/format.js';
import { runStatusLabel, taskStatusView } from '../lib/labels.js';
import { workbenchContext, pendingNewTask } from '../composables/useWorkbenchContext.js';
import { t } from '../lib/i18n.js';
import { useNotification } from '../composables/useNotifications.js';
import type { AgentInputMode } from '../lib/drafts.js';
import AgentImagePicker from './agent/AgentImagePicker.vue';
import AgentDictation from './agent/AgentDictation.vue';
import AppDialog from './AppDialog.vue';
import AgentTaskInput from './agent/AgentTaskInput.vue';
import AgentPendingMessages, { type SteeringDeliveryView } from './agent/AgentPendingMessages.vue';
import AgentTaskList from './agent/AgentTaskList.vue';
import AgentTimeline from './agent/AgentTimeline.vue';
import AgentDesktopPanel from './agent/AgentDesktopPanel.vue';
import AgentResultPanel from './agent/AgentResultPanel.vue';
import AgentLiveChanges from './agent/AgentLiveChanges.vue';
import AgentTaskMetrics from './agent/AgentTaskMetrics.vue';
import AgentReviewPanel from './agent/AgentReviewPanel.vue';
import AgentReleasePanel from './agent/AgentReleasePanel.vue';
import AgentAppPanel from './agent/AgentAppPanel.vue';
import { createUuid } from '../lib/uuid.js';

const cockpit = useAgentCockpit();
const {
  snapshot,
  connection,
  error,
  streamIssue,
  submitting,
  steering,
  cancelling,
  continuing,
  accepting,
  merging,
  reviewing,
  correcting,
  resolving,
  conflictedRunId,
  releasing,
  deploying,
  projects,
  tasks,
  selectedTaskId,
  selectedTask,
  tasksLoading,
} = cockpit;
const { appRoute, navigateTo } = useAppRoute();
const showTaskDialog = ref(false);
const task = ref('');
const taskImages = ref<AgentInputImage[]>([]);
const preparingImages = ref(false);
const dictating = ref(false);
const name = ref('');
const projectId = ref('');
const activeProjects = computed(() => projects.value.filter((project) => !project.archived));
const projectMode = ref<'existing' | 'app' | 'github'>('existing');
const newProjectName = ref('');
const githubUrl = ref('');
const creatingProject = ref(false);
const creationKey = ref(createUuid());
watch([newProjectName, githubUrl, projectMode], () => {
  creationKey.value = createUuid();
});
const selectedAppProject = computed(() =>
  projects.value.find(
    (entry) => entry.id === selectedTask.value?.task.projectId && entry.appCapable
  )
);
const showProjectForm = ref(false);
const projectName = ref('');
const projectPath = ref('');
const projectBranch = ref('main');
const projectWorkdir = ref('.');
const projectEditPaths = ref('.');
const projectDependency = ref('');
const projectCheck = ref('');
const registeringProject = ref(false);
const selectedRunId = ref<string>();
const historicalSnapshot = ref<AgentRunSnapshot>();
const historyLoading = ref(false);
const selectedResult = ref<AgentRunResult>();
// Every historical trace request carries this generation. A response is only
// applied if the task, the selected run and the request generation are still
// the same, so a slow older response can never overwrite a newer selection or
// reset a selection the user has already changed.
let historyGeneration = 0;
let cockpitUnmounted = false;
const taskView = ref<'activity' | 'changes' | 'desktop' | 'preview' | 'details'>('activity');
const metricsScope = ref<'task' | 'run'>('run');
const detailSection = ref<'runs' | 'review' | 'release'>('runs');
const now = ref(Date.now());
let clock: ReturnType<typeof setInterval> | undefined;
const splitMedia = globalThis.matchMedia?.('(min-width: 1100px)');
const wideWorkspace = ref(splitMedia?.matches ?? false);
const splitWorkspace = computed(
  () => wideWorkspace.value && ['changes', 'desktop', 'preview'].includes(taskView.value)
);
const workspaceSplit = useWorkspaceSplit();
const splitElement = workspaceSplit.element;
let desktopShownForRun = '';
function updateSplit(event: MediaQueryListEvent) {
  wideWorkspace.value = event.matches;
}
onMounted(() => splitMedia?.addEventListener('change', updateSplit));
onUnmounted(() => splitMedia?.removeEventListener('change', updateSplit));

const mayStart = computed(() => {
  if (!engineMode.value.agentsAllowed) return false;
  if (snapshot.value?.enabled !== true) return false;
  // The durable task list is authoritative across parallel runs. A run-bound
  // snapshot can legitimately retain the capacity value from the instant that
  // run completed, which previously hid Continue and disabled Review until a
  // different global snapshot happened to arrive.
  const activeRuns =
    tasks.value.activeTaskIds.length > 0
      ? tasks.value.activeTaskIds.length
      : tasks.value.activeTaskId === undefined
        ? 0
        : 1;
  return activeRuns < (snapshot.value.maxActiveRuns ?? 1);
});
const selectedIsActive = computed(() =>
  ['starting', 'running'].includes(selectedTask.value?.task.latestRun.status ?? '')
);
const selectedSteering = computed<SteeringDeliveryView[]>(() => {
  const runId = selectedTask.value?.task.latestRun.id;
  if (runId === undefined) return [];
  return (
    selectedTask.value?.steering
      .filter((entry) => entry.runId === runId && entry.confirmedAt === undefined)
      .map((entry) => ({
        id: entry.id,
        text: entry.text,
        status: entry.status,
        ...(entry.confirmedAt === undefined ? {} : { confirmedAt: entry.confirmedAt }),
      })) ?? []
  );
});
const selectedIsLive = computed(
  () =>
    selectedTask.value?.task.latestRun.id !== undefined &&
    selectedTask.value.task.latestRun.id === snapshot.value?.runId
);
const chipState = computed<
  'connected' | 'connecting' | 'disconnected' | 'disabled' | 'unreachable'
>(() => {
  // The chip reflects the runner's availability, never the raw transport
  // state: an open Observatory event stream does not make a disabled or
  // unreachable runner healthy.
  const status = snapshot.value?.status;
  if (snapshot.value?.enabled === false && status === 'disabled') return 'disabled';
  if (snapshot.value?.enabled === false && status === 'unreachable') return 'unreachable';
  if (connection.value === 'connected' && snapshot.value?.enabled !== true) return 'connecting';
  return connection.value;
});
const chipText = computed(() =>
  chipState.value === 'disabled'
    ? t('agent.chipDisabled')
    : chipState.value === 'unreachable'
      ? t('agent.chipUnreachable')
      : chipState.value === 'connected'
        ? t('agent.live')
        : chipState.value === 'connecting'
          ? t('agent.connecting')
          : t('agent.disconnected')
);
const displayedSnapshot = computed(() => {
  if (selectedRunId.value !== undefined && historicalSnapshot.value !== undefined) {
    return historicalSnapshot.value;
  }
  // While a historical trace is loading, do not present the latest run (or
  // the global snapshot) as the selected historical run's state.
  if (historyLoading.value) return undefined;
  if (selectedTaskId.value === undefined || selectedIsLive.value) return snapshot.value;
  return selectedTask.value?.latestSnapshot;
});
const desktopRun = computed(() =>
  displayedSnapshot.value?.timeline.some(
    (item) =>
      item.toolName?.startsWith('desktop_') ||
      (displayedSnapshot.value?.desktopAvailable && item.toolName?.startsWith('browser_'))
  )
    ? displayedSnapshot.value.runId
    : undefined
);
watch(
  desktopRun,
  (runId) => {
    if (
      runId &&
      selectedIsActive.value &&
      desktopShownForRun !== runId &&
      taskView.value === 'activity'
    ) {
      desktopShownForRun = runId;
      taskView.value = 'desktop';
    }
  },
  { immediate: true, flush: 'post' }
);
const selectedDurableRun = computed(() => {
  const detail = selectedTask.value;
  if (detail === undefined) return undefined;
  const runId = selectedRunId.value ?? detail.task.latestRun.id;
  return detail.runs.find((run) => run.id === runId) ?? detail.task.latestRun;
});
// While the current run is displayed the durable task title is canonical; a
// selected historical run keeps its own snapshot name instead.
const detailTitle = computed(() =>
  selectedRunId.value === undefined ? (selectedTask.value?.task.title ?? undefined) : undefined
);
const regeneratingTitle = ref(false);
const titleNotice = ref('');
useNotification(titleNotice, 'task-title', 'notice');
const canRegenerateTitle = computed(
  () =>
    engineMode.value.agentsAllowed &&
    selectedTaskId.value !== undefined &&
    snapshot.value?.enabled === true &&
    regeneratingTitle.value === false
);
async function regenerateTitle(): Promise<void> {
  const taskId = selectedTaskId.value;
  if (taskId === undefined || regeneratingTitle.value) return;
  regeneratingTitle.value = true;
  titleNotice.value = '';
  error.value = '';
  try {
    const result = await regenerateAgentTaskTitle(taskId);
    titleNotice.value = t(result.regenerated ? 'agent.titleRegenerated' : 'agent.titleUnchanged');
    // Re-reading the list also reselects the task, so the bumped task
    // version refetches the detail and the fresh title is displayed.
    await cockpit.refreshTasks();
  } catch (cause) {
    error.value =
      cause instanceof HealthFetchError ? cause.message : t('agent.titleRegenerationFailed');
  } finally {
    regeneratingTitle.value = false;
  }
}
const releaseCapable = computed(
  () =>
    projects.value.find((project) => project.id === selectedTask.value?.task.projectId)
      ?.releaseTarget === 'observatory'
);
const selectedReleases = computed(() =>
  selectedDurableRun.value === undefined
    ? []
    : (selectedTask.value?.releases.filter(
        (release) => release.runId === selectedDurableRun.value?.id
      ) ?? [])
);
const runEntries = computed(() => {
  const detail = selectedTask.value;
  if (detail === undefined) return [];
  const chronological = [...detail.runs].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) ||
      Number(a.id === detail.task.latestRun.id) - Number(b.id === detail.task.latestRun.id)
  );
  return [...chronological].reverse().map((run) => {
    const chronologicalIndex = chronological.findIndex((candidate) => candidate.id === run.id);
    const message = detail.messages.find(
      (candidate) => candidate.runId === run.id && candidate.role === 'user'
    );
    const source =
      chronologicalIndex === 0
        ? detail.task.title
        : (message?.text ?? t('agent.runNumber', { number: chronologicalIndex + 1 }));
    const normalized = source.replace(/\s+/g, ' ').trim();
    return {
      run,
      number: chronologicalIndex + 1,
      title: normalized.length > 72 ? `${normalized.slice(0, 69)}…` : normalized,
      fullTitle: normalized,
      isCurrent: run.id === detail.task.latestRun.id,
    };
  });
});
const visibleError = computed(() =>
  error.value !== ''
    ? error.value
    : streamIssue.value?.kind === 'schema'
      ? streamIssue.value.message
      : ''
);
useNotification(visibleError, 'agent-cockpit');
// The compact status is derived from the selected durable task itself (run
// status, open question, stored result), never from an unrelated global run.
const taskState = computed(() => {
  const detail = selectedTask.value;
  if (detail === undefined)
    return { label: t('label.loading'), action: undefined as string | undefined };
  const run = detail.task.latestRun;
  return taskStatusView({
    snapshotStatus: displayedSnapshot.value?.status,
    taskStatus: detail.task.status,
    runStatus: run.status,
    hasResult: run.resultRevision !== undefined,
    hasOpenQuestion: detail.openQuestion?.status === 'open',
  });
});
const isHistoricalRun = computed(() => {
  const detail = selectedTask.value;
  return (
    detail !== undefined &&
    selectedRunId.value !== undefined &&
    selectedRunId.value !== detail.task.latestRun.id
  );
});
// Which of the existing actions the single input of the task performs right
// now. Archived tasks, missing capacity and historical runs never produce an
// actionable input.
const inputAvailability = computed<
  'steer' | 'answer' | 'continue' | 'history' | 'archived' | 'queued' | 'noCapacity'
>(() => {
  if (!engineMode.value.agentsAllowed) return 'noCapacity';
  const detail = selectedTask.value;
  if (detail === undefined) return 'noCapacity';
  if (isHistoricalRun.value) return 'history';
  if (detail.task.status === 'archived') return 'archived';
  // Active run wins: like the old UI, a running task offers Steer even when a
  // question is stored as open; Answer applies once the run is inactive.
  if (detail.task.latestRun.status === 'queued') return 'queued';
  if (selectedIsActive.value) return 'steer';
  if (detail.openQuestion?.status === 'open') return 'answer';
  return snapshot.value?.enabled === true ? 'continue' : 'noCapacity';
});
const runtime = computed(() => {
  const startedAt = selectedDurableRun.value?.startedAt ?? displayedSnapshot.value?.startedAt;
  if (startedAt === undefined) return '–';
  const finishedAt = selectedDurableRun.value?.finishedAt ?? displayedSnapshot.value?.finishedAt;
  const end = finishedAt ? new Date(finishedAt).getTime() : now.value;
  return formatRuntimeClock(Math.max(0, (end - new Date(startedAt).getTime()) / 1000));
});

async function startRun(): Promise<void> {
  if (!engineMode.value.agentsAllowed) return;
  if (creatingProject.value || submitting.value || preparingImages.value) return;
  if (projectMode.value !== 'existing') {
    creatingProject.value = true;
    try {
      const project = await createAgentProject({
        name: newProjectName.value,
        idempotencyKey: creationKey.value,
        source:
          projectMode.value === 'app' ? { kind: 'app' } : { kind: 'github', url: githubUrl.value },
      });
      await cockpit.refreshProjects();
      projectId.value = project.id;
      projectMode.value = 'existing';
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : t('agent.projectSaveFailed');
      return;
    } finally {
      creatingProject.value = false;
    }
  }
  const sentImages = taskImages.value;
  const sentText = task.value;
  const ok = await cockpit.start({
    projectId: projectId.value,
    task: sentText,
    ...(sentImages.length === 0 ? {} : { images: sentImages }),
    ...(name.value.trim() === '' ? {} : { name: name.value }),
  });
  if (ok) {
    showTaskDialog.value = false;
    if (task.value === sentText) task.value = '';
    if (taskImages.value === sentImages) taskImages.value = [];
    name.value = '';
  }
}

async function cancelRun(): Promise<void> {
  await cockpit.cancel();
}

/**
 * The single input of the selected task routes to the existing API of the
 * current mode. The returned boolean tells the input whether the backend
 * confirmed the action, which decides whether the text and its local draft
 * are cleared.
 */
async function sendTaskMessage(
  text: string,
  mode: AgentInputMode,
  images?: AgentInputImage[]
): Promise<boolean> {
  if (mode === 'steer') return cockpit.steer(text);
  if (mode === 'followup') return cockpit.queueFollowup(text);
  if (mode === 'answer') return cockpit.answerQuestion(text);
  return cockpit.continueTask(text, images);
}

async function startReview(input: {
  sourceRunId: string;
  resultRevision: string;
  instructions?: string;
}): Promise<void> {
  await cockpit.startReview(input);
}

async function startCorrection(input: {
  reviewId: string;
  findingIds: string[];
  instructions?: string;
}): Promise<void> {
  if (await cockpit.startCorrection(input)) taskView.value = 'activity';
}

async function resolveConflict(result: AgentRunResult): Promise<void> {
  if (await cockpit.resolveConflict(result)) taskView.value = 'activity';
}

async function addProject(): Promise<void> {
  registeringProject.value = true;
  try {
    const checks =
      projectCheck.value.trim() === ''
        ? []
        : [
            {
              label: projectCheck.value.trim(),
              argv: projectCheck.value.trim().split(/\s+/),
            },
          ];
    const project = await registerAgentProject({
      name: projectName.value,
      repositoryPath: projectPath.value,
      targetBranch: projectBranch.value,
      workdir: projectWorkdir.value || '.',
      editPaths: projectEditPaths.value
        .split(',')
        .map((path) => path.trim())
        .filter(Boolean),
      ...(projectDependency.value.trim() === ''
        ? {}
        : { dependencyPath: projectDependency.value.trim() }),
      checks,
    });
    await cockpit.refreshProjects();
    projectId.value = project.id;
    showProjectForm.value = false;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t('agent.projectSaveFailed');
  } finally {
    registeringProject.value = false;
  }
}

async function selectRun(runId: string, openConversation = true): Promise<void> {
  if (!selectedTask.value?.runs.some((run) => run.id === runId)) return;
  const generation = ++historyGeneration;
  const taskId = selectedTaskId.value;
  selectedRunId.value = runId;
  if (openConversation) taskView.value = 'activity';
  if (selectedTaskId.value)
    writeTaskView(selectedTaskId.value, { runId, metricsScope: metricsScope.value });
  if (runId === selectedTask.value?.task.latestRun.id) {
    historicalSnapshot.value = undefined;
    historyLoading.value = false;
    selectedResult.value = selectedTask.value.latestResult;
    return;
  }
  const run = selectedTask.value?.runs.find((candidate) => candidate.id === runId);
  // While the new trace is loading, never show the previous run's history as
  // if it belonged to this run.
  historicalSnapshot.value = undefined;
  selectedResult.value = undefined;
  historyLoading.value = true;
  try {
    const [events, result] = await Promise.all([
      collectAgentRunTrace(runId, { failOnStalledCursor: true }),
      run?.resultRevision === undefined ? Promise.resolve(undefined) : fetchAgentRunResult(runId),
    ]);
    if (
      generation !== historyGeneration ||
      cockpitUnmounted ||
      selectedTaskId.value !== taskId ||
      selectedRunId.value !== runId
    )
      return;
    let value: AgentRunSnapshot | undefined;
    for (const entry of events) {
      if (entry.event.operation === 'reset') value = entry.event.snapshot;
      else if (value !== undefined) value = reduceAgentSnapshot(value, entry.event);
    }
    historicalSnapshot.value = value;
    selectedResult.value = result;
  } catch {
    if (
      generation !== historyGeneration ||
      cockpitUnmounted ||
      selectedTaskId.value !== taskId ||
      selectedRunId.value !== runId
    )
      return;
    // A failed history load must not leave the cockpit inconsistent: the
    // sidebar would mark a historical run while the timeline falls back to
    // the latest snapshot. Reset the selection and surface the error.
    selectedRunId.value = undefined;
    if (taskId) writeTaskView(taskId, { metricsScope: metricsScope.value });
    historicalSnapshot.value = undefined;
    selectedResult.value = undefined;
    error.value = t('agent.historyLoadFailed');
  } finally {
    if (generation === historyGeneration && !cockpitUnmounted) historyLoading.value = false;
  }
}

onMounted(() => {
  clock = setInterval(() => {
    now.value = Date.now();
  }, 1_000);
});
onUnmounted(() => clearInterval(clock));
onBeforeUnmount(() => {
  cockpitUnmounted = true;
  historyGeneration += 1;
});

watch(
  activeProjects,
  (items) => {
    if (!items.some((project) => project.id === projectId.value))
      projectId.value = items[0]?.id ?? '';
  },
  { immediate: true }
);
watch(
  [selectedTask, detailTitle, taskState],
  ([detail, title, state]) => {
    if (detail)
      Object.assign(workbenchContext, {
        projectId: detail.task.projectId,
        projectName: detail.task.projectName,
        taskId: detail.task.id,
        taskTitle: title ?? displayedSnapshot.value?.name ?? detail.task.title,
        taskStatus: state.label,
        taskAction: state.action ?? '',
        taskRunStatus: detail.task.latestRun.status,
        taskMapNodeId: detail.task.architectureTarget?.nodeId ?? '',
        taskMapLabel: detail.task.architectureTarget?.label ?? '',
      });
  },
  { immediate: true }
);
let restoredTaskId: string | undefined;
watch(metricsScope, (scope) => {
  if (selectedTaskId.value && restoredTaskId === selectedTaskId.value)
    writeTaskView(selectedTaskId.value, { runId: selectedRunId.value, metricsScope: scope });
});
watch(selectedTaskId, () => {
  restoredTaskId = undefined;
  historyGeneration += 1;
  selectedRunId.value = undefined;
  historicalSnapshot.value = undefined;
  historyLoading.value = false;
  selectedResult.value = selectedTask.value?.latestResult;
  taskView.value = appRoute.view === 'changes' ? 'changes' : 'activity';
  detailSection.value = 'runs';
});
// Route -> selection: restores a task after a refresh (the hash is read
// before first render) and follows browser back/forward between `#/agent`
// and `#/agent/<taskId>`.
watch(
  () => appRoute.taskId,
  (taskId) => {
    if (appRoute.page !== 'agent') return;
    if (taskId === undefined) {
      if (selectedTaskId.value !== undefined) cockpit.showTaskList();
      return;
    }
    if (taskId !== selectedTaskId.value) void cockpit.selectTask(taskId);
  },
  { immediate: true }
);
watch(
  () => appRoute.view,
  (view) => {
    taskView.value = view === 'changes' ? 'changes' : 'activity';
  },
  { immediate: true }
);
// Selection -> route: the URL always mirrors the open task; navigateTo only
// writes a changed hash, so no hashchange loop can occur.
watch(selectedTaskId, (taskId) => {
  if (appRoute.page !== 'agent') return;
  if (appRoute.taskId === taskId) return;
  navigateTo('agent', taskId);
});
watch(
  pendingNewTask,
  (request) => {
    if (!request) return;
    if (activeProjects.value.some((project) => project.id === request.projectId)) {
      projectId.value = request.projectId!;
      projectMode.value = 'existing';
    }
    showTaskDialog.value = true;
    pendingNewTask.value = undefined;
  },
  { immediate: true }
);
watch(selectedTask, (detail) => {
  if (detail && detail.task.id === selectedTaskId.value && restoredTaskId !== detail.task.id) {
    restoredTaskId = detail.task.id;
    const state = readTaskView(detail.task.id);
    metricsScope.value = state.metricsScope;
    if (state.runId && detail.runs.some((run) => run.id === state.runId))
      void selectRun(state.runId, false);
  }
  if (selectedRunId.value === undefined || selectedRunId.value === detail?.task.latestRun.id) {
    selectedResult.value = detail?.latestResult;
  }
});
</script>

<template>
  <section
    class="cockpit"
    :class="{ 'task-focused': selectedTaskId !== undefined }"
    :aria-label="t('agent.title')"
  >
    <div v-if="selectedTaskId === undefined" class="overview-heading cockpit-heading">
      <h2 id="cockpit-title">{{ t('agent.tasks') }}</h2>
      <span class="live-chip" :class="chipState" role="status">
        <span class="live-dot" aria-hidden="true"></span>
        {{ chipText }}
      </span>
      <button
        v-if="connection === 'disconnected'"
        class="text-button"
        type="button"
        :title="streamIssue?.message"
        @click="cockpit.reconnect"
      >
        {{ t('agent.reconnect') }}
      </button>
    </div>

    <section v-if="snapshot?.enabled === false" class="panel cockpit-disabled">
      <template v-if="snapshot.status === 'disabled'">
        <h3>{{ t('agent.disabled') }}</h3>
        <p>{{ t('agent.disabledText') }}</p>
      </template>
      <template v-else-if="snapshot.status === 'unreachable'">
        <h3>{{ t('agent.unreachable') }}</h3>
        <p>{{ t('agent.unreachableText') }}</p>
      </template>
      <template v-else>
        <h3>{{ t('agent.disabled') }}</h3>
        <p>{{ snapshot.reason }}</p>
      </template>
    </section>

    <template v-else>
      <div v-if="selectedTaskId === undefined" class="task-overview-layout">
        <div class="task-overview-actions">
          <button
            class="primary-button"
            type="button"
            :disabled="!engineMode.agentsAllowed || snapshot?.enabled !== true"
            @click="showTaskDialog = true"
          >
            {{ t('agent.newTask') }}
          </button>
        </div>
        <AgentTaskList :items="tasks.items" :loading="tasksLoading" @select="cockpit.selectTask" />

        <AppDialog
          v-if="showTaskDialog"
          :title="t('agent.newTask')"
          @close="showTaskDialog = false"
        >
          <form class="agent-form" @submit.prevent="startRun">
            <label for="agent-project-mode">{{ t('agent.projectSource') }}</label>
            <select
              id="agent-project-mode"
              v-model="projectMode"
              :disabled="creatingProject || submitting"
            >
              <option value="existing">{{ t('agent.existingProject') }}</option>
              <option value="app">{{ t('agent.newAppProject') }}</option>
              <option value="github">{{ t('agent.cloneGithub') }}</option>
            </select>
            <template v-if="projectMode !== 'existing'">
              <label for="new-project-name">{{ t('agent.projectName') }}</label>
              <input
                id="new-project-name"
                v-model="newProjectName"
                required
                maxlength="160"
                :disabled="creatingProject || submitting"
              />
              <template v-if="projectMode === 'github'">
                <label for="github-url">{{ t('agent.githubUrl') }}</label>
                <input
                  id="github-url"
                  v-model="githubUrl"
                  type="url"
                  required
                  maxlength="512"
                  placeholder="https://github.com/owner/repository"
                  :disabled="creatingProject || submitting"
                />
                <p>{{ t('agent.githubHint') }}</p>
              </template>
              <p v-else>{{ t('agent.newAppHint') }}</p>
            </template>
            <template v-else>
              <label for="agent-project">{{ t('agent.project') }}</label>
              <select id="agent-project" v-model="projectId" required>
                <option v-for="project in activeProjects" :key="project.id" :value="project.id">
                  {{ project.name }}
                </option>
              </select>
              <button
                class="text-button project-add-toggle"
                type="button"
                @click="showProjectForm = !showProjectForm"
              >
                {{ showProjectForm ? t('agent.closeProjectForm') : t('agent.addLocalProject') }}
              </button>
            </template>
            <label for="agent-name"
              >{{ t('agent.name') }} <span>({{ t('agent.optional') }})</span></label
            >
            <input
              id="agent-name"
              v-model="name"
              maxlength="160"
              :placeholder="t('agent.namePlaceholder')"
            />
            <label for="agent-task">{{ t('agent.task') }}</label>
            <textarea
              id="agent-task"
              v-model="task"
              maxlength="65536"
              rows="9"
              required
              :placeholder="t('agent.taskPlaceholder')"
            ></textarea>
            <AgentDictation
              :disabled="submitting || creatingProject"
              @busy="dictating = $event"
              @transcript="task = [task.trimEnd(), $event].filter(Boolean).join(' ')"
            />
            <AgentImagePicker
              v-model="taskImages"
              :disabled="submitting || creatingProject"
              @busy="preparingImages = $event"
            />
            <button
              class="primary-button"
              type="submit"
              :disabled="
                !engineMode.agentsAllowed ||
                creatingProject ||
                submitting ||
                preparingImages ||
                dictating ||
                task.trim() === '' ||
                (projectMode !== 'existing' && newProjectName.trim() === '')
              "
            >
              {{
                creatingProject
                  ? t('agent.creatingProject')
                  : submitting
                    ? t('agent.starting')
                    : t('agent.start')
              }}
            </button>
          </form>

          <form
            v-if="showProjectForm"
            class="panel agent-form project-form"
            @submit.prevent="addProject"
          >
            <h3>{{ t('agent.registerProject') }}</h3>
            <label for="project-name">{{ t('agent.projectName') }}</label>
            <input id="project-name" v-model="projectName" required maxlength="160" />
            <label for="project-path">{{ t('agent.localGitPath') }}</label>
            <input
              id="project-path"
              v-model="projectPath"
              required
              maxlength="1024"
              placeholder="/path/to/projects/..."
            />
            <label for="project-branch">{{ t('agent.targetBranch') }}</label>
            <input id="project-branch" v-model="projectBranch" required maxlength="256" />
            <label for="project-workdir">{{ t('agent.workdir') }}</label>
            <input id="project-workdir" v-model="projectWorkdir" required maxlength="512" />
            <label for="project-edit-paths"
              >{{ t('agent.allowedPaths') }} <span>({{ t('agent.commaSeparated') }})</span></label
            >
            <input
              id="project-edit-paths"
              v-model="projectEditPaths"
              required
              maxlength="2048"
              placeholder="src, tests"
            />
            <label for="project-dependency"
              >{{ t('agent.dependencies') }} <span>({{ t('agent.optionalRelative') }})</span></label
            >
            <input
              id="project-dependency"
              v-model="projectDependency"
              maxlength="512"
              placeholder="node_modules"
            />
            <label for="project-check"
              >{{ t('agent.check') }} <span>({{ t('agent.optionalArgv') }})</span></label
            >
            <input
              id="project-check"
              v-model="projectCheck"
              maxlength="2048"
              placeholder="/usr/bin/npm test"
            />
            <button class="primary-button" type="submit" :disabled="registeringProject">
              {{ registeringProject ? t('agent.validatingProject') : t('agent.saveProject') }}
            </button>
          </form>
        </AppDialog>
        <div v-if="activeProjects.some((entry) => entry.appCapable)" class="managed-apps">
          <AgentAppPanel
            v-for="project in activeProjects.filter((entry) => entry.appCapable)"
            :key="project.id"
            :project-id="project.id"
            :name="project.name"
          />
        </div>
      </div>

      <template v-else>
        <div class="task-toolbar">
          <AgentTaskMetrics
            v-if="selectedTask && selectedDurableRun"
            :key="selectedTask.task.id"
            :task-id="selectedTask.task.id"
            :run-id="selectedDurableRun.id"
            :runtime="runtime"
            :scope="metricsScope"
            :active="selectedIsActive"
            :initial="selectedTask.telemetry"
          />
          <nav class="task-view-tabs" role="tablist" :aria-label="t('agent.taskView')">
            <button
              type="button"
              role="tab"
              :aria-selected="taskView === 'activity'"
              :class="{ active: taskView === 'activity' }"
              @click="taskView = 'activity'"
            >
              {{ t('agent.conversation') }}
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="taskView === 'changes'"
              :class="{
                active: taskView === 'changes',
              }"
              :disabled="selectedDurableRun === undefined"
              @click="taskView = 'changes'"
            >
              {{ t('agent.changes') }}
              <span v-if="selectedResult">{{ selectedResult.files.length }}</span>
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="taskView === 'desktop'"
              :class="{
                active: taskView === 'desktop',
              }"
              @click="taskView = 'desktop'"
            >
              {{ t('desktop.title') }}
            </button>
            <button
              v-if="selectedAppProject"
              type="button"
              role="tab"
              :aria-selected="taskView === 'preview'"
              :class="{ active: taskView === 'preview' }"
              @click="taskView = 'preview'"
            >
              {{ t('agent.appPreview') }}
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="taskView === 'details'"
              :class="{ active: taskView === 'details' }"
              @click="taskView = 'details'"
            >
              {{ t('agent.details') }}
            </button>
          </nav>
          <span
            class="live-chip task-connection"
            :class="chipState"
            role="status"
            :aria-label="chipText"
            :title="chipText"
          >
            <span class="live-dot" aria-hidden="true"></span>
          </span>
          <button
            v-if="connection === 'disconnected'"
            class="text-button"
            type="button"
            :title="streamIssue?.message"
            @click="cockpit.reconnect"
          >
            {{ t('agent.reconnect') }}
          </button>
        </div>

        <div
          v-if="taskView !== 'details'"
          ref="splitElement"
          class="task-live-workspace"
          :style="splitWorkspace ? workspaceSplit.style.value : undefined"
          :class="{
            'split-workspace': splitWorkspace,
            'screenshot-workspace': taskView === 'desktop',
          }"
        >
          <div
            v-show="splitWorkspace || taskView === 'activity'"
            class="conversation-view"
            role="tabpanel"
          >
            <AgentTimeline
              :key="historyLoading ? 'history-loading' : selectedDurableRun?.id"
              :items="displayedSnapshot?.timeline ?? []"
              :loading="tasksLoading || historyLoading"
              :durable-run-status="selectedDurableRun?.status"
              :is-live-run="selectedIsActive && !isHistoricalRun"
              :run-id="displayedSnapshot?.runId"
              :subagents="displayedSnapshot?.subagents"
            />

            <AgentPendingMessages
              v-if="!isHistoricalRun"
              :pending-steering="displayedSnapshot?.pendingSteering"
              :deliveries="selectedSteering"
            />
            <AgentTaskInput
              v-if="
                inputAvailability === 'steer' ||
                inputAvailability === 'answer' ||
                inputAvailability === 'continue'
              "
              :task-id="selectedTask!.task.id"
              :base-mode="inputAvailability"
              :is-active="selectedIsActive"
              :can-toggle-followup="
                inputAvailability === 'steer' && selectedTask?.queuedFollowup === undefined
              "
              :question="selectedTask?.openQuestion?.question"
              :queued-followup="selectedTask?.queuedFollowup"
              :steering="steering"
              :continuing="continuing"
              :cancelling="cancelling"
              :can-pause="displayedSnapshot?.engine === 'pi-durable'"
              :on-submit="sendTaskMessage"
              @cancel="cancelRun"
              @pause="cockpit.pause"
            />

            <div v-else-if="inputAvailability === 'history'" class="task-note" role="status">
              <p>{{ t('agent.historyNote') }}</p>
              <button
                class="text-button"
                type="button"
                @click="selectRun(selectedTask!.task.latestRun.id)"
              >
                {{ t('agent.backToCurrentRun') }}
              </button>
            </div>
            <p v-else-if="inputAvailability === 'archived'" class="task-note" role="status">
              {{ t('agent.archivedNote') }}
            </p>
            <div v-else-if="inputAvailability === 'queued'" class="task-note" role="status">
              <p>{{ t('agent.queueWaiting') }}</p>
              <button class="text-button" type="button" :disabled="cancelling" @click="cancelRun">
                {{ t('agent.cancelQueued') }}
              </button>
            </div>
            <p
              v-else-if="inputAvailability === 'noCapacity' && engineMode.agentsAllowed"
              class="task-note"
              role="status"
            >
              {{ t('agent.noCapacity') }}
            </p>
          </div>

          <div
            v-if="splitWorkspace"
            class="workspace-splitter"
            role="separator"
            tabindex="0"
            aria-orientation="vertical"
            :aria-label="t('workspace.resize')"
            :aria-valuenow="Math.round(workspaceSplit.ratio.value)"
            :aria-valuemin="25"
            :aria-valuemax="75"
            @pointerdown="workspaceSplit.start"
            @pointermove="workspaceSplit.move"
            @pointerup="workspaceSplit.end"
            @pointercancel="workspaceSplit.end"
            @lostpointercapture="workspaceSplit.end"
            @keydown="workspaceSplit.key"
          ></div>
          <AgentAppPanel
            v-if="taskView === 'preview' && selectedAppProject"
            class="app-preview-view"
            :project-id="selectedAppProject.id"
            :name="selectedAppProject.name"
            :run-id="selectedDurableRun?.id"
            :revision="selectedDurableRun?.resultRevision"
            :can-start="
              selectedDurableRun?.status === 'completed' &&
              selectedDurableRun?.resultRevision !== undefined
            "
          />

          <AgentDesktopPanel
            v-if="selectedDurableRun && taskView === 'desktop'"
            :key="selectedDurableRun.id"
            :run-id="selectedDurableRun.id"
            :items="displayedSnapshot?.timeline ?? []"
          />
          <section v-show="taskView === 'changes'" class="changes-view" role="tabpanel">
            <AgentResultPanel
              v-if="
                selectedResult &&
                selectedResult.runId === selectedDurableRun?.id &&
                !['queued', 'starting', 'running'].includes(selectedDurableRun?.status ?? '')
              "
              :result="selectedResult"
              :task-id="selectedTask?.task.id"
              :accepting="accepting"
              :merging="merging"
              :resolving="resolving"
              :can-resolve-conflict="conflictedRunId === selectedResult?.runId"
              @accept="cockpit.acceptResult"
              @merge="cockpit.mergeResult"
              @resolve-conflict="resolveConflict"
            />
            <p v-else-if="selectedDurableRun?.status === 'queued'" class="task-note" role="status">
              {{ t('agent.queueNoChanges') }}
            </p>
            <AgentLiveChanges
              v-else-if="selectedTask && selectedDurableRun"
              :task-id="selectedTask.task.id"
              :run-id="selectedDurableRun.id"
              :active="['starting', 'running'].includes(selectedDurableRun.status)"
              :visible="taskView === 'changes'"
            />
            <p v-else class="task-empty">{{ t('agent.noResult') }}</p>
          </section>
        </div>

        <section v-else class="details-view" role="tabpanel">
          <label class="task-metric-scope"
            ><span>{{ t('metrics.task') }}</span
            ><select v-model="metricsScope">
              <option value="task">{{ t('metrics.allRuns') }}</option>
              <option value="run">{{ t('metrics.selectedRun') }}</option>
            </select></label
          >
          <section class="panel task-metadata" :aria-label="t('agent.details')">
            <p v-if="taskState.action">{{ taskState.action }}</p>
            <dl class="task-properties">
              <dt>{{ t('agent.runtime') }}</dt>
              <dd>{{ runtime }}</dd>
              <dt>{{ t('details.taskId') }}</dt>
              <dd>
                <code>{{ selectedTask?.task.id }}</code>
              </dd>
              <dt>{{ t('details.runId') }}</dt>
              <dd>
                <code>{{ selectedDurableRun?.id }}</code>
              </dd>
              <dt>{{ t('details.profile') }}</dt>
              <dd>{{ selectedDurableRun?.profileId }}</dd>
              <dt>{{ t('details.revision') }}</dt>
              <dd>
                <code>{{
                  selectedDurableRun?.resultRevision ?? selectedDurableRun?.baseRevision
                }}</code>
              </dd>
              <template v-if="displayedSnapshot?.model"
                ><dt>{{ t('details.model') }}</dt>
                <dd>{{ displayedSnapshot.model }}</dd></template
              >
            </dl>
            <button
              class="text-button regenerate-title"
              type="button"
              :disabled="!canRegenerateTitle"
              @click="regenerateTitle"
            >
              {{ regeneratingTitle ? t('agent.regeneratingTitle') : t('agent.regenerateTitle') }}
            </button>
          </section>
          <nav class="details-subnav" role="tablist" :aria-label="t('agent.details')">
            <button
              type="button"
              role="tab"
              :aria-selected="detailSection === 'runs'"
              :class="{ active: detailSection === 'runs' }"
              @click="detailSection = 'runs'"
            >
              {{ t('agent.runs') }}
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="detailSection === 'review'"
              :class="{ active: detailSection === 'review' }"
              :disabled="selectedDurableRun?.resultRevision === undefined"
              @click="detailSection = 'review'"
            >
              {{ t('agent.reviews') }}
              <span v-if="selectedTask?.reviews.length">{{ selectedTask.reviews.length }}</span>
            </button>
            <button
              type="button"
              role="tab"
              :aria-selected="detailSection === 'release'"
              :class="{ active: detailSection === 'release' }"
              :disabled="selectedDurableRun?.resultRevision === undefined"
              @click="detailSection = 'release'"
            >
              {{ t('agent.release') }}
              <span v-if="selectedReleases.length">{{ selectedReleases.length }}</span>
            </button>
          </nav>

          <div
            v-if="detailSection === 'runs'"
            class="panel run-sidebar"
            role="tabpanel"
            :aria-label="t('agent.runs')"
          >
            <nav class="run-list" :aria-label="t('agent.runs')">
              <button
                v-for="entry in runEntries"
                :key="entry.run.id"
                type="button"
                :class="{
                  active:
                    selectedRunId === entry.run.id ||
                    (selectedRunId === undefined && entry.isCurrent),
                }"
                :title="entry.fullTitle"
                :aria-current="
                  selectedRunId === entry.run.id || (selectedRunId === undefined && entry.isCurrent)
                    ? 'true'
                    : undefined
                "
                @click="selectRun(entry.run.id, false)"
              >
                <span class="run-entry-heading">
                  <strong
                    ><span class="run-entry-number">{{ entry.number }}.</span>
                    {{ entry.title }}</strong
                  >
                  <em v-if="entry.isCurrent">{{ t('agent.currentRun') }}</em>
                </span>
                <span class="run-entry-meta">
                  <small>{{ runStatusLabel(entry.run.status, undefined) }}</small>
                  <time :datetime="entry.run.createdAt">
                    {{ formatShortDateTime(entry.run.createdAt) }}
                  </time>
                </span>
              </button>
            </nav>
          </div>

          <AgentReviewPanel
            v-else-if="detailSection === 'review'"
            :reviews="selectedTask?.reviews ?? []"
            :result="selectedResult"
            :may-start="mayStart"
            :reviewing="reviewing"
            :correcting="correcting"
            :live-snapshot="snapshot"
            @review="startReview"
            @correct="startCorrection"
          />

          <AgentReleasePanel
            v-else
            :result="selectedResult"
            :releases="selectedReleases"
            :capable="releaseCapable"
            :releasing="releasing"
            :deploying="deploying"
            :deployment="selectedTask?.deployment"
            @prepare="cockpit.startRelease"
            @activate="cockpit.activateRelease"
            @rollback="cockpit.rollbackRelease"
          />
        </section>
      </template>
    </template>
  </section>
</template>
