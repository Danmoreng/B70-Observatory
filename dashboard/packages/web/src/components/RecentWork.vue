<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue';
import type { RecentWork } from '@observatory/contracts';
import { fetchRecentWork } from '../lib/api.js';
import { formatShortDateTime } from '../lib/format.js';
import { t } from '../lib/i18n.js';
import { taskStatusLabel } from '../lib/labels.js';
import AppIcon from './AppIcon.vue';

const work = ref<RecentWork>();
const failed = ref(false);
const session = new AbortController();
let timer: ReturnType<typeof setTimeout>;
async function refresh() {
  if (!document.hidden) {
    try {
      work.value = await fetchRecentWork(
        AbortSignal.any([session.signal, AbortSignal.timeout(5000)])
      );
      failed.value = false;
    } catch {
      failed.value = true;
    }
  }
  if (!session.signal.aborted) timer = setTimeout(refresh, 15000);
}
onMounted(refresh);
onUnmounted(() => {
  session.abort();
  clearTimeout(timer);
});
</script>
<template>
  <div class="recent-work">
    <p v-if="failed" class="inline-error" role="status">{{ t('home.unavailable') }}</p>
    <section aria-labelledby="recent-tasks">
      <header>
        <h2 id="recent-tasks">{{ t('home.recentTasks') }}</h2>
        <a href="#/agent">{{ t('home.allTasks') }} <AppIcon name="right" /></a>
      </header>
      <ul v-if="work?.tasks.length">
        <li v-for="task in work.tasks" :key="task.id">
          <a class="activity-link" :href="'#/agent/' + task.id">
            <span class="activity-main"
              ><strong>{{ task.title }}</strong
              ><small>{{ task.projectName }}</small></span
            >
            <span class="activity-meta"
              ><span :class="'state-' + task.runStatus">{{
                task.runStatus === 'running'
                  ? t('engine.state.active')
                  : taskStatusLabel(task.runStatus)
              }}</span>
              <time :datetime="task.updatedAt">{{
                formatShortDateTime(task.updatedAt)
              }}</time></span
            >
          </a>
        </li>
      </ul>
      <p v-else-if="!failed">{{ work ? t('agent.noTasks') : t('label.loading') }}</p>
    </section>
    <section aria-labelledby="recent-projects">
      <header>
        <h2 id="recent-projects">{{ t('home.recentProjects') }}</h2>
        <a href="#/projects">{{ t('home.allProjects') }} <AppIcon name="right" /></a>
      </header>
      <ul v-if="work?.projects.length">
        <li v-for="project in work.projects" :key="project.id">
          <a class="activity-link" :href="'#/projects/' + project.id">
            <AppIcon name="folder" /><span class="activity-main"
              ><strong>{{ project.name }}</strong></span
            >
            <time :datetime="project.updatedAt">{{ formatShortDateTime(project.updatedAt) }}</time>
          </a>
        </li>
      </ul>
      <p v-else-if="!failed">{{ work ? t('home.noProjects') : t('label.loading') }}</p>
    </section>
  </div>
</template>
<style scoped>
.recent-work {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.recent-work > .inline-error {
  grid-column: 1/-1;
  margin: 0;
}
.recent-work section {
  min-width: 0;
}
header {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
}
h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
header a {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--accent);
  font-size: 12px;
  text-decoration: none;
  white-space: nowrap;
}
header a:hover {
  text-decoration: underline;
}
header .app-icon {
  width: 14px;
  height: 14px;
}
ul {
  list-style: none;
  padding: 0;
  margin: 0;
  border-block: 1px solid var(--border);
}
li + li {
  border-top: 1px solid var(--border);
}
.activity-link {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 50px;
  padding: 6px 8px;
  text-decoration: none;
  color: var(--text);
}
.activity-link:hover,
.activity-link:focus-visible {
  background: var(--panel);
}
.activity-main {
  min-width: 0;
  flex: 1;
}
.activity-main strong,
.activity-main small {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.activity-main strong {
  font-size: 13px;
  font-weight: 550;
}
.activity-main small,
time,
section > p,
.activity-meta {
  color: var(--dim);
  font-size: 12px;
}
.activity-meta {
  display: grid;
  text-align: right;
}
time {
  white-space: nowrap;
}
.activity-link > .app-icon {
  width: 17px;
  color: var(--dim);
}
.state-running,
.state-starting {
  color: var(--ok);
}
.state-queued,
.state-yielded {
  color: var(--warn);
}
.state-failed,
.state-interrupted {
  color: var(--error);
}
@container (max-width: 690px) {
  .recent-work {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
