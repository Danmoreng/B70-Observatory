<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import type {
  AgentProject,
  DurableTaskList,
  MemoryRecord,
  MemoryRequest,
  MemoryResponse,
  MemoryWrite,
} from '@observatory/contracts';
import { MemoryWriteSchema } from '@observatory/contracts';
import { fetchAgentProjects, fetchAgentTasks, memoryRequest, agentImageUrl } from '../lib/api.js';
import { t } from '../lib/i18n.js';
const records = ref<MemoryRecord[]>([]),
  projects = ref<AgentProject[]>([]);
const status = ref<MemoryResponse['status']>(),
  query = ref(''),
  project = ref(''),
  scope = ref('');
const busy = ref(false),
  error = ref(''),
  warning = ref(''),
  message = ref('');
const evidence = ref<NonNullable<MemoryResponse['evidence']>>([]);
const selected = ref<MemoryRecord>(),
  editing = ref(false),
  history = ref<MemoryRecord[]>([]);
const title = ref(''),
  content = ref(''),
  entryScope = ref<MemoryWrite['scope']>('project'),
  entryProject = ref('');
const entryStatus = ref<MemoryWrite['status']>('proposed'),
  visibility = ref<MemoryWrite['visibility']>('local');
const kind = ref<MemoryWrite['kind']>('fact'),
  sources = ref('user:Dashboard'),
  validUntil = ref('');
const tasks = ref<DurableTaskList['items']>([]),
  run = ref('');
const sourceImages = ref<NonNullable<MemoryResponse['runImages']>>([]),
  chosenImage = ref(''),
  imageTitle = ref(''),
  imageDescription = ref(''),
  imagePurpose = ref<'reference' | 'bug' | 'before' | 'after'>('reference');
async function loadImages() {
  sourceImages.value = [];
  chosenImage.value = '';
  if (!run.value) return;
  try {
    sourceImages.value = (await call({ operation: 'runImages', runId: run.value })).runImages ?? [];
  } catch (e) {
    error.value = String(e);
  }
}
async function captureImage() {
  if (!run.value || !chosenImage.value) return;
  busy.value = true;
  try {
    await call({
      operation: 'capture',
      runId: run.value,
      imageId: chosenImage.value,
      title: imageTitle.value,
      description: imageDescription.value,
      purpose: imagePurpose.value,
    });
    chosenImage.value = '';
    imageTitle.value = '';
    imageDescription.value = '';
    await load();
  } catch (e) {
    error.value = String(e);
  } finally {
    busy.value = false;
  }
}
const availableTasks = computed(() =>
  tasks.value.filter((task) =>
    ['completed', 'failed', 'cancelled', 'interrupted'].includes(task.latestRun.status)
  )
);
async function call(input: MemoryRequest) {
  return await memoryRequest(input);
}
let generation = 0;
let disposed = false;
let poll: ReturnType<typeof setTimeout> | undefined;
onUnmounted(() => {
  disposed = true;
  generation++;
  if (poll) clearTimeout(poll);
});
async function refreshStatus() {
  if (disposed) return;
  try {
    const result = await call({ operation: 'status' });
    if (!disposed) {
      const changed=status.value?.embeddedImages !== result.status?.embeddedImages;
      status.value=result.status;
      if(changed && records.value.some(item=>item.image))await load();
    }
  } catch {
    /* foreground actions report connection errors */
  }
  if (!disposed)
    poll = setTimeout(() => void refreshStatus(), status.value?.indexing ? 2000 : 10000);
}
async function load() {
  const request = ++generation;
  error.value = '';
  busy.value = true;
  try {
    const [result, health] = await Promise.all([
      call(
        query.value.trim()
          ? {
              operation: 'search',
              query: query.value.trim(),
              projectId: project.value || undefined,
              includeEpisodes: true,
              limit: 30,
            }
          : {
              operation: 'list',
              projectId: project.value || undefined,
              scope: (scope.value || undefined) as MemoryWrite['scope'] | undefined,
            }
      ),
      call({ operation: 'status' }),
    ]);
    if (request !== generation || disposed) return;
    records.value = (result.items ?? []).filter((r) => !scope.value || r.scope === scope.value);
    status.value = health.status;
    warning.value = result.warning ?? '';
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (request === generation) busy.value = false;
  }
}
onMounted(async () => {
  await load();
  if (!disposed) poll = setTimeout(() => void refreshStatus(), 2000);
  try {
    projects.value = (await fetchAgentProjects()).filter((p) => !p.archived);
    entryProject.value = projects.value[0]?.id ?? '';
    tasks.value = (await fetchAgentTasks()).items;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
});
function edit(item?: MemoryRecord) {
  selected.value = item;
  title.value = item?.title ?? '';
  content.value = item?.content ?? '';
  entryScope.value = item?.scope ?? 'project';
  entryProject.value = item?.projectId ?? (project.value || projects.value[0]?.id || '');
  entryStatus.value = item?.status ?? 'proposed';
  visibility.value = item?.visibility ?? 'local';
  kind.value = item?.kind ?? 'fact';
  sources.value = item?.sources.map((s) => s.kind + ':' + s.ref).join('\n') ?? 'user:Dashboard';
  const expiry = item?.validUntil ? new Date(item.validUntil) : undefined;
  validUntil.value = expiry
    ? new Date(expiry.getTime() - expiry.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
    : '';
  editing.value = true;
  history.value = [];
}
function entry(): MemoryWrite {
  const refs = sources.value
    .split('\n')
    .filter((s) => s.trim())
    .map((line) => {
      const i = line.indexOf(':');
      return { kind: line.slice(0, i), ref: line.slice(i + 1) };
    });
  return MemoryWriteSchema.parse({
    title: title.value,
    content: content.value,
    scope: entryScope.value,
    projectId: entryScope.value === 'project' ? entryProject.value : undefined,
    status: entryStatus.value,
    visibility: visibility.value,
    kind: kind.value,
    sources: refs,
    validUntil: validUntil.value ? new Date(validUntil.value).toISOString() : undefined,
  });
}
async function save() {
  busy.value = true;
  error.value = '';
  try {
    const e = entry();
    await call(
      selected.value
        ? { operation: 'update', id: selected.value.id, version: selected.value.version, entry: e }
        : { operation: 'create', entry: e }
    );
    editing.value = false;
    message.value = t('memory.saved');
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
async function confirm(item: MemoryRecord) {
  const { id, version, createdAt, updatedAt, machineId, score, image, ...e } = item;
  void createdAt;
  void updatedAt;
  void machineId;
  void score;
  void image;
  try {
    await call({ operation: 'update', id, version, entry: { ...e, status: 'confirmed' } });
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
async function remove(item: MemoryRecord) {
  if (!window.confirm(t('memory.deleteConfirm'))) return;
  try {
    await call({ operation: 'remove', id: item.id, version: item.version });
    history.value = [];
    evidence.value = [];
    if (selected.value?.id === item.id) {
      editing.value = false;
      selected.value = undefined;
      content.value = '';
      title.value = '';
    }
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
async function showHistory(item: MemoryRecord) {
  try {
    history.value = (await call({ operation: 'history', id: item.id })).items ?? [];
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
async function ingest() {
  if (!run.value) return;
  busy.value = true;
  try {
    const result = await call({ operation: 'ingest', runId: run.value });
    message.value = t('memory.imported', { count: result.imported ?? 0 });
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
async function maintain() {
  busy.value = true;
  try {
    const result = await call({ operation: 'maintenance' });
    message.value = t('memory.maintenanceResult', {
      duplicates: result.maintenance?.duplicateGroups.length ?? 0,
      expired: result.maintenance?.expired.length ?? 0,
    });
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
async function showEvidence(item: MemoryRecord) {
  try {
    evidence.value = (await call({ operation: 'evidence', id: item.id })).evidence ?? [];
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
async function distill() {
  if (!run.value) return;
  busy.value = true;
  error.value = '';
  message.value = t('memory.distilling');
  try {
    const result = await call({ operation: 'distill', runId: run.value });
    message.value = t('memory.distilled', { count: result.distillation?.created ?? 0 });
    await load();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
function scopeLabel(value: MemoryWrite['scope']) {
  return t(
    value === 'developer'
      ? 'memory.developer'
      : value === 'workstation'
        ? 'memory.workstation'
        : 'memory.project'
  );
}
function stateLabel(value: MemoryWrite['status']) {
  return t(
    value === 'confirmed'
      ? 'memory.confirmed'
      : value === 'proposed'
        ? 'memory.proposed'
        : 'memory.superseded'
  );
}
</script>
<template>
  <section class="memory-panel">
    <header class="memory-heading">
      <div>
        <h1>{{ t('memory.title') }}</h1>
        <p>{{ t('memory.description') }}</p>
      </div>
      <button class="primary-button" @click="edit()">＋ {{ t('memory.new') }}</button>
    </header>
    <p v-if="error" class="inline-error" role="alert">{{ error }}</p>
    <p v-if="warning" role="status">{{ warning }}</p>
    <p v-if="message" role="status">{{ message }}</p>
    <div v-if="status" class="memory-status panel">
      <strong>{{ status.model }} · CPU · {{ status.dimensions }}D</strong
      ><span>{{
        t('memory.counts', {
          confirmed: status.confirmed,
          proposed: status.proposed,
          episodes: status.episodes,
        })
      }}</span
      ><span>{{ t('memory.embeddings', { done: status.embedded, total: status.chunks }) }}</span
      ><span v-if="status.indexing">{{ t('memory.indexing') }}</span
      ><span v-if="status.error" class="inline-error">{{ status.error }}</span
      ><span v-if="!status.semanticReady">{{ t('memory.keywordOnly') }}</span>
    </div>
    <form class="memory-filters panel" @submit.prevent="load">
      <label
        >{{ t('memory.search')
        }}<input v-model="query" :placeholder="t('memory.searchHint')" type="search"
      /></label>
      <label
        >{{ t('memory.scope')
        }}<select v-model="scope" @change="load">
          <option value="">{{ t('memory.all') }}</option>
          <option value="developer">{{ t('memory.developer') }}</option>
          <option value="workstation">{{ t('memory.workstation') }}</option>
          <option value="project">{{ t('memory.project') }}</option>
        </select></label
      >
      <label
        >{{ t('memory.project')
        }}<select v-model="project" @change="load">
          <option value="">{{ t('memory.allProjects') }}</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
        </select></label
      >
      <button class="quiet-button" :disabled="busy">{{ t('memory.search') }}</button
      ><button class="quiet-button" type="button" :disabled="busy" @click="maintain">
        {{ t('memory.maintenance') }}
      </button>
    </form>
    <form v-if="editing" class="panel memory-editor" @submit.prevent="save">
      <h2>{{ selected ? t('memory.edit') : t('memory.new') }}</h2>
      <label>{{ t('memory.entryTitle') }}<input v-model="title" required maxlength="160" /></label>
      <label
        >{{ t('memory.content') }}<textarea v-model="content" required maxlength="16000" rows="6" />
      </label>
      <div class="memory-filters">
        <label
          >{{ t('memory.scope')
          }}<select v-model="entryScope">
            <option value="developer">{{ t('memory.developer') }}</option>
            <option value="workstation">{{ t('memory.workstation') }}</option>
            <option value="project">{{ t('memory.project') }}</option>
          </select></label
        >
        <label v-if="entryScope === 'project'"
          >{{ t('memory.project')
          }}<select v-model="entryProject" required>
            <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select></label
        >
        <label
          >{{ t('memory.state')
          }}<select v-model="entryStatus">
            <option value="proposed">{{ t('memory.proposed') }}</option>
            <option value="confirmed">{{ t('memory.confirmed') }}</option>
            <option value="superseded">{{ t('memory.superseded') }}</option>
          </select></label
        >
        <label
          >{{ t('memory.visibility')
          }}<select v-model="visibility">
            <option value="local">{{ t('memory.local') }}</option>
            <option value="shared">{{ t('memory.shared') }}</option>
          </select></label
        >
      </div>
      <label
        >{{ t('memory.sources')
        }}<textarea v-model="sources" required rows="2" :placeholder="t('memory.sourceHint')" />
      </label>
      <label>{{ t('memory.expiry') }}<input v-model="validUntil" type="datetime-local" /></label>
      <div class="memory-actions">
        <button class="quiet-button" :disabled="busy">{{ t('memory.save') }}</button
        ><button class="quiet-button" type="button" @click="editing = false">
          {{ t('memory.cancel') }}
        </button>
      </div>
    </form>
    <div class="memory-records" :aria-busy="busy">
      <p v-if="!records.length && !busy">{{ t('memory.empty') }}</p>
      <article v-for="item in records" :key="item.id" class="panel memory-record">
        <header>
          <h2>{{ item.title }}</h2>
          <span
            >{{ scopeLabel(item.scope) }} · {{ stateLabel(item.status) }} · v{{ item.version }} ·
            {{ item.visibility === 'local' ? t('memory.local') : t('memory.shared') }}</span
          ><span v-if="item.projectId">{{
            projects.find((p) => p.id === item.projectId)?.name
          }}</span>
        </header>
        <p v-if="item.kind === 'episode'" class="memory-episode">{{ t('memory.episode') }}</p>
        <p class="memory-content">{{ item.content }}</p>
        <figure v-if="item.image" class="memory-image">
          <a :href="`/api/agent/memory/${item.id}/image`" target="_blank" rel="noopener"
            ><img :src="`/api/agent/memory/${item.id}/image`" :alt="item.title" loading="lazy"
          /></a>
          <figcaption>
            {{ t('memory.visual') }} · {{ item.image.purpose }} ·
            {{ new Date(item.image.capturedAt).toLocaleString() }} · {{ t('memory.runBase') }}
            {{ item.image.revision.slice(0, 8) }} ·
            {{ item.image.embedded ? t('memory.imageIndexed') : t('memory.imagePending') }}
          </figcaption>
        </figure>
        <p class="memory-sources">
          {{ t('memory.sources') }}:
          <span v-for="(source, i) in item.sources" :key="i"
            >{{ source.kind }}:{{ source.ref }}
          </span>
        </p>
        <p>
          {{ t('memory.updated') }} {{ new Date(item.updatedAt).toLocaleString()
          }}<span v-if="item.validUntil">
            · {{ t('memory.expiry') }} {{ new Date(item.validUntil).toLocaleString() }}</span
          >
        </p>
        <div class="memory-actions">
          <button v-if="item.kind !== 'episode'" class="quiet-button" @click="edit(item)">
            {{ t('memory.edit') }}
</button
          ><button
            v-if="item.status === 'proposed' && item.kind !== 'episode'"
            class="quiet-button"
            @click="confirm(item)"
          >
            {{ t('memory.confirm') }}
</button
          ><button class="quiet-button" @click="showEvidence(item)">
            {{ t('memory.evidence') }}
</button
          ><button class="quiet-button" @click="showHistory(item)">{{ t('memory.history') }}</button
          ><button class="quiet-button" @click="remove(item)">{{ t('memory.delete') }}</button>
        </div>
      </article>
    </div>
    <section v-if="evidence.length" class="panel memory-evidence">
      <h2>{{ t('memory.evidence') }}</h2>
      <article v-for="(source, i) in evidence" :key="i">
        <strong>{{ source.kind }}:{{ source.ref }}</strong>
        <p v-if="source.text" class="memory-content">{{ source.text }}</p>
        <a v-if="source.taskId" :href="`#/agent/${source.taskId}`">{{ t('memory.openSource') }}</a>
      </article>
      <button class="quiet-button" @click="evidence = []">{{ t('memory.close') }}</button>
    </section>
    <section v-if="history.length" class="panel memory-history">
      <h2>{{ t('memory.history') }}</h2>
      <article v-for="item in history" :key="item.version">
        <strong>v{{ item.version }} · {{ stateLabel(item.status) }}</strong>
        <p class="memory-content">{{ item.content }}</p>
        <figure v-if="item.image" class="memory-image">
          <a :href="`/api/agent/memory/${item.id}/image`" target="_blank" rel="noopener"
            ><img :src="`/api/agent/memory/${item.id}/image`" :alt="item.title" loading="lazy"
          /></a>
          <figcaption>
            {{ t('memory.visual') }} · {{ item.image.purpose }} ·
            {{ new Date(item.image.capturedAt).toLocaleString() }} · {{ t('memory.runBase') }}
            {{ item.image.revision.slice(0, 8) }} ·
            {{ item.image.embedded ? t('memory.imageIndexed') : t('memory.imagePending') }}
          </figcaption>
        </figure>
      </article>
      <button class="quiet-button" @click="history = []">{{ t('memory.close') }}</button>
    </section>
    <form class="panel memory-import" @submit.prevent="ingest">
      <h2>{{ t('memory.import') }}</h2>
      <p>{{ t('memory.importHint') }}</p>
      <label
        >{{ t('memory.run')
        }}<select v-model="run" required @change="loadImages">
          <option value="">{{ t('memory.chooseRun') }}</option>
          <option v-for="task in availableTasks" :key="task.id" :value="task.latestRun.id">
            {{ task.title }}
          </option>
        </select></label
      ><button class="quiet-button" :disabled="busy || !run">{{ t('memory.import') }}</button>
      <button class="quiet-button" type="button" :disabled="busy || !run" @click="distill">
        {{ t('memory.distill') }}
      </button>
    </form>
    <form v-if="run" class="panel memory-import" @submit.prevent="captureImage">
      <h2>{{ t('memory.visual') }}</h2>
      <p>{{ t('memory.visualHint') }}</p>
      <div class="memory-image-picker">
        <label v-for="image in sourceImages" :key="image.id"
          ><input v-model="chosenImage" type="radio" :value="image.id" required /><img
            :src="agentImageUrl(image.runId, image.id)"
            :alt="image.label || image.id"
            loading="lazy"
        /></label>
      </div>
      <p v-if="!sourceImages.length">{{ t('memory.noImages') }}</p>
      <label>{{ t('memory.title') }}<input v-model="imageTitle" required maxlength="160" /></label>
      <label
        >{{ t('memory.content')
        }}<textarea v-model="imageDescription" required maxlength="16000" rows="3" />
      </label>
      <label
        >{{ t('memory.purpose')
        }}<select v-model="imagePurpose">
          <option value="reference">{{ t('memory.reference') }}</option>
          <option value="bug">{{ t('memory.bug') }}</option>
          <option value="before">{{ t('memory.before') }}</option>
          <option value="after">{{ t('memory.after') }}</option>
        </select></label
      >
      <button class="quiet-button" :disabled="busy || !chosenImage">
        {{ t('memory.capture') }}
      </button>
    </form>
  </section>
</template>
<style scoped>
.memory-panel .panel {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  padding: 18px;
}
.memory-record {
  display: grid;
  gap: 10px;
}
.memory-record header span {
  color: var(--dim);
  font-size: 12px;
}
.memory-import > button {
  justify-self: start;
}
.memory-panel {
  display: grid;
  gap: 1rem;
  max-width: 1100px;
  margin: 0 auto;
}
.memory-heading {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 1rem;
}
.memory-heading h1 {
  margin: 0;
}
.memory-heading p {
  color: var(--dim);
  max-width: 70ch;
}
.memory-status {
  display: flex;
  gap: 1rem;
  flex-wrap: wrap;
}
.memory-filters {
  display: flex;
  gap: 0.8rem;
  align-items: end;
  flex-wrap: wrap;
}
.memory-filters label:first-child {
  flex: 1;
  min-width: 220px;
}
.memory-panel label {
  display: grid;
  gap: 0.35rem;
}
.memory-editor {
  display: grid;
  gap: 0.8rem;
}
.memory-records {
  display: grid;
  gap: 0.8rem;
}
.memory-record {
  overflow-wrap: anywhere;
}
.memory-record h2 {
  margin: 0 0 0.4rem;
}
.memory-record header {
  display: flex;
  gap: 0.6rem;
  align-items: baseline;
  flex-wrap: wrap;
}
.memory-record header h2 {
  flex-basis: 100%;
}
.memory-content {
  white-space: pre-wrap;
  line-height: 1.55;
}
.memory-sources {
  font-size: 0.85rem;
  color: var(--dim);
}
.memory-actions {
  display: flex;
  gap: 0.6rem;
  flex-wrap: wrap;
}
.memory-episode {
  color: var(--dim);
  font-style: italic;
}
.memory-import {
  display: grid;
  gap: 0.8rem;
}
.memory-panel input,
.memory-panel textarea,
.memory-panel select {
  width: 100%;
  box-sizing: border-box;
}
.memory-history article {
  border-top: 1px solid var(--border);
  padding: 0.6rem 0;
}
</style>

<style scoped>
.memory-image img {
  display: block;
  max-width: 100%;
  max-height: 420px;
  object-fit: contain;
}
.memory-image {
  margin: 0;
}
.memory-image figcaption {
  color: var(--dim);
  font-size: 12px;
}
.memory-image-picker {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
}
.memory-image-picker label {
  width: 180px;
  max-width: 100%;
}
.memory-image-picker img {
  width: 100%;
  height: 120px;
  object-fit: contain;
}
</style>
