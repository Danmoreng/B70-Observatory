<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { t } from '../../lib/i18n.js';
import type { AgentLiveChanges } from '@observatory/contracts';

type DiffLineKind = 'file' | 'hunk' | 'addition' | 'deletion' | 'context' | 'meta';

interface DiffLine {
  key: number;
  kind: DiffLineKind;
  content: string;
  oldNumber?: number;
  newNumber?: number;
}

const props = defineProps<{
  diff: string;
  taskId?: string;
  runId?: string;
  imageVersion?: string;
  files?: string[];
  truncated?: boolean;
  fileStatuses?: AgentLiveChanges['files'];
}>();
const selectedPath = ref('');
const wrap = ref(true);
const imageFailed = ref(false);
const imageUrl = computed(() =>
  props.taskId &&
  props.runId &&
  selected.value &&
  props.fileStatuses?.find((file) => file.path === selected.value?.path)?.status !== 'deleted' &&
  /\.(?:png|jpe?g|webp)$/i.test(selected.value.path)
    ? '/api/agent/tasks/' +
      encodeURIComponent(props.taskId) +
      '/change-image?' +
      new URLSearchParams({
        runId: props.runId,
        path: selected.value.path,
        ...(props.imageVersion ? { version: props.imageVersion } : {}),
      })
    : undefined
);
function fileStatusLabel(path: string): string {
  const status = props.fileStatuses?.find((file) => file.path === path)?.status;
  return status ? t(`liveChanges.${status}`) : '';
}

const lines = computed<DiffLine[]>(() => {
  if (props.diff === '') return [];
  const source = props.diff.split('\n');
  if (source.at(-1) === '') source.pop();
  let oldNumber: number | undefined;
  let newNumber: number | undefined;
  return source.map((content, key) => {
    if (content.startsWith('diff --git ')) {
      oldNumber = undefined;
      newNumber = undefined;
      return { key, kind: 'file', content };
    }
    if (content.startsWith('@@')) {
      const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(content);
      oldNumber = match === null ? undefined : Number(match[1]);
      newNumber = match === null ? undefined : Number(match[2]);
      return { key, kind: 'hunk', content };
    }
    if (content.startsWith('+') && !content.startsWith('+++')) {
      const line: DiffLine = {
        key,
        kind: 'addition',
        content,
        ...(newNumber === undefined ? {} : { newNumber }),
      };
      if (newNumber !== undefined) newNumber += 1;
      return line;
    }
    if (content.startsWith('-') && !content.startsWith('---')) {
      const line: DiffLine = {
        key,
        kind: 'deletion',
        content,
        ...(oldNumber === undefined ? {} : { oldNumber }),
      };
      if (oldNumber !== undefined) oldNumber += 1;
      return line;
    }
    if (content.startsWith(' ')) {
      const line: DiffLine = {
        key,
        kind: 'context',
        content,
        ...(oldNumber === undefined ? {} : { oldNumber }),
        ...(newNumber === undefined ? {} : { newNumber }),
      };
      if (oldNumber !== undefined) oldNumber += 1;
      if (newNumber !== undefined) newNumber += 1;
      return line;
    }
    return { key, kind: 'meta', content };
  });
});

interface FilePatch {
  path: string;
  lines: DiffLine[];
  added: number;
  removed: number;
}
function displayPath(value: string): string {
  let path = value;
  if (path.startsWith('"')) {
    try {
      path = JSON.parse(path) as string;
    } catch {
      /* retain Git's escaped filename */
    }
  }
  return path.replace(/^[ab]\//, '');
}
const preamble = computed(() => {
  const first = lines.value.findIndex((line) => line.kind === 'file');
  return first > 0
    ? lines.value
        .slice(0, first)
        .map((line) => line.content)
        .join('\n')
        .trim()
    : '';
});
const patches = computed<FilePatch[]>(() => {
  const result: FilePatch[] = [];
  let current: FilePatch | undefined;
  const first = lines.value.findIndex((line) => line.kind === 'file');
  for (const line of first < 0 ? lines.value : lines.value.slice(first)) {
    if (line.kind === 'file' || current === undefined) {
      const match = /^diff --git (?:"a\/.*"|a\/.*) ("b\/.*"|b\/.*)$/.exec(line.content);
      current = {
        path: match ? displayPath(match[1]!) : t('agent.diff'),
        lines: [],
        added: 0,
        removed: 0,
      };
      result.push(current);
    }
    if (line.content.startsWith('+++ ') && line.content.slice(4) !== '/dev/null')
      current.path = displayPath(line.content.slice(4));
    current.lines.push(line);
    if (line.kind === 'addition') current.added++;
    if (line.kind === 'deletion') current.removed++;
  }
  for (const path of props.files ?? []) {
    if (!result.some((entry) => entry.path === path))
      result.push({ path, lines: [], added: 0, removed: 0 });
  }
  return result;
});
const selected = computed(
  () => patches.value.find((entry) => entry.path === selectedPath.value) ?? patches.value[0]
);
watch(imageUrl, () => {
  imageFailed.value = false;
});
const binary = computed(() =>
  Boolean(
    selected.value &&
    (/\.(?:png|jpe?g|webp|gif|avif|ico|bmp|tiff?|pdf|zip|gz|woff2?|ttf|mp[34]|wav|sqlite|db)$/i.test(
      selected.value.path
    ) ||
      selected.value.lines.some((line) => /^(?:GIT binary patch|Binary files )/.test(line.content)))
  )
);
const displayedLines = computed(
  () =>
    selected.value?.lines.filter(
      (line) =>
        line.kind !== 'file' &&
        !(line.kind === 'meta' && /^(?:index |--- |\+\+\+ )/.test(line.content))
    ) ?? []
);
watch(
  patches,
  (value) => {
    if (!value.some((entry) => entry.path === selectedPath.value))
      selectedPath.value = value[0]?.path ?? '';
  },
  { immediate: true }
);
</script>

<template>
  <pre v-if="preamble" class="diff-overview-summary">{{ preamble }}</pre>
  <section v-if="patches.length" class="file-review" :aria-label="t('agent.diff')">
    <nav class="diff-file-list" :aria-label="t('agent.changedFiles', { count: patches.length })">
      <p>{{ t('agent.changedFiles', { count: patches.length }) }}</p>
      <button
        v-for="(patch, index) in patches"
        :key="patch.path + index"
        type="button"
        :aria-pressed="selected?.path === patch.path"
        :data-file="patch.path"
        @click="selectedPath = patch.path"
      >
        <span
          >{{ patch.path
          }}<small v-if="fileStatusLabel(patch.path)" class="diff-file-status">{{
            fileStatusLabel(patch.path)
          }}</small></span
        ><small
          ><span class="diff-added">+{{ patch.added }}</span>
          <span class="diff-removed">−{{ patch.removed }}</span></small
        >
      </button>
    </nav>
    <div class="diff-selected-file">
      <header class="diff-file-heading">
        <code>{{ selected?.path }}</code
        ><label><input v-model="wrap" type="checkbox" /> {{ t('map.wrapLines') }}</label>
      </header>
      <p v-if="truncated" class="diff-truncation" role="status">{{ t('map.diffTruncated') }}</p>
      <div v-if="binary && imageUrl && !imageFailed" class="diff-image-preview">
        <a :href="imageUrl" target="_blank" rel="noopener"
          ><img :src="imageUrl" :alt="selected?.path" @error="imageFailed = true"
        /></a>
      </div>
      <p v-else-if="binary" class="diff-empty binary-file-notice">
        {{ t(imageFailed ? 'map.imageUnavailable' : 'map.binaryFile') }}
      </p>
      <div
        v-else-if="selected?.lines.length"
        class="agent-diff-view"
        :class="{ 'wrap-lines': wrap }"
      >
        <table>
          <colgroup>
            <col class="diff-number-column" />
            <col class="diff-number-column" />
            <col />
          </colgroup>
          <tbody>
            <tr v-for="line in displayedLines" :key="line.key" :class="line.kind">
              <td class="diff-line-number">{{ line.oldNumber ?? '' }}</td>
              <td class="diff-line-number">{{ line.newNumber ?? '' }}</td>
              <td class="diff-line-code">
                <code>{{ line.content }}</code>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="diff-empty">{{ t('map.noPatch') }}</p>
    </div>
  </section>
  <p v-else class="diff-empty">{{ t('agent.noCodeChanges') }}</p>
</template>

<style scoped>
.diff-image-preview {
  padding: 10px;
  text-align: center;
  background: var(--panel);
}
.diff-image-preview img {
  display: block;
  max-width: 100%;
  max-height: 65vh;
  width: auto;
  height: auto;
  object-fit: scale-down;
  margin: auto;
}
.file-review {
  column-gap: 8px;
}
.diff-file-list button[aria-pressed='true'] {
  box-shadow: inset 3px 0 var(--accent);
}

.diff-overview-summary {
  font-size: 11px;
  line-height: 1.6;
  color: var(--dim);
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  margin: 8px 0;
}

.file-review {
  display: grid;
  grid-template-columns: minmax(150px, 24%) minmax(0, 1fr);
  border: 0;
  border-radius: 0;
  overflow: hidden;
  margin-top: 6px;
  min-width: 0;
}
.diff-file-list {
  background: var(--panel);
  border-right: 1px solid var(--border);
  padding: 6px;
  max-height: 65vh;
  overflow: auto;
}
.diff-file-list p {
  font-size: 11px;
  color: var(--dim);
  margin: 4px 4px 6px;
}
.diff-file-list button {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  text-align: left;
  gap: 5px;
  width: 100%;
  min-height: 44px;
  padding: 6px;
  margin-bottom: 2px;
  border: 1px solid transparent;
  border-radius: 3px;
  background: transparent;
  color: var(--text);
  font-size: 11px;
  overflow-wrap: anywhere;
}
.diff-file-list button[aria-pressed='true'] {
  background: var(--raised);
  border-color: var(--accent);
}
.diff-file-list small {
  font-size: 10px;
}
.diff-added {
  color: #89d7aa;
}
.diff-removed {
  color: #f3a3a3;
}
.diff-selected-file {
  min-width: 0;
}
.diff-file-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 8px;
  background: var(--panel);
  border-bottom: 1px solid var(--border);
}
.diff-file-heading code {
  font-size: 11px;
  overflow-wrap: anywhere;
  min-width: 0;
}
.diff-file-heading label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  color: var(--dim);
  white-space: nowrap;
}
.diff-file-heading input {
  min-height: 18px;
}
.agent-diff-view table {
  font-size: 13px;
  line-height: 1.7;
}
.agent-diff-view tr.meta {
  display: table-row;
}
.agent-diff-view {
  margin: 0;
  border: 0;
  border-radius: 0;
  max-height: 65vh;
}
.agent-diff-view.wrap-lines table {
  width: 100%;
  table-layout: fixed;
}
.diff-number-column {
  width: 40px;
}
.wrap-lines .diff-line-code {
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.wrap-lines .diff-line-code code {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.wrap-lines .diff-line-number {
  width: 40px;
}
.diff-truncation {
  padding: 6px;
  color: var(--warn);
  font-size: 12px;
}
.diff-selected-file > .diff-empty {
  padding: 14px;
}
.diff-line-number {
  color: #a0b0be;
}
@media (max-width: 640px) {
  .file-review {
    grid-template-columns: minmax(0, 1fr);
  }
  .diff-file-list {
    max-height: 210px;
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }
  .diff-file-list button {
    flex-direction: row;
    justify-content: space-between;
    align-items: center;
  }
  .diff-file-list small {
    flex: none;
  }
}
</style>
