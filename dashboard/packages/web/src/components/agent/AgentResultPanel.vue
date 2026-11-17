<script setup lang="ts">
import { computed } from 'vue';
import type { AgentRunResult } from '@observatory/contracts';
import { t } from '../../lib/i18n.js';
import AgentDiffView from './AgentDiffView.vue';

const props = defineProps<{
  result?: AgentRunResult;
  taskId?: string;
  accepting: boolean;
  merging: boolean;
  resolving: boolean;
  canResolveConflict: boolean;
}>();
const emit = defineEmits<{
  accept: [result: AgentRunResult];
  merge: [result: AgentRunResult];
  resolveConflict: [result: AgentRunResult];
}>();
const accepted = computed(
  () => props.result !== undefined && props.result.acceptedAt !== undefined
);
const merged = computed(() => props.result !== undefined && props.result.mergedAt !== undefined);
</script>

<template>
  <section v-if="result" class="panel agent-result" aria-labelledby="agent-result-title">
    <div class="agent-result-heading">
      <div>
        <h3 id="agent-result-title">{{ t('agent.result') }}</h3>
        <code>{{ result.resultRevision.slice(0, 12) }}</code
        ><span class="result-check-status" :class="result.checkStatus"
          >{{ t('agent.checks') }} ·
          {{
            t(
              result.checkStatus === 'not_run'
                ? 'agent.notRun'
                : result.checkStatus === 'passed'
                  ? 'agent.passed'
                  : 'agent.failed'
            )
          }}</span
        >
      </div>
      <div class="agent-result-actions">
        <button
          v-if="canResolveConflict"
          class="quiet-button"
          type="button"
          :disabled="resolving || accepting || merging"
          @click="emit('resolveConflict', result)"
        >
          {{ resolving ? t('agent.conflictResolutionStarting') : t('agent.resolveConflict') }}
        </button>
        <button
          v-if="!accepted"
          class="primary-button"
          type="button"
          :disabled="accepting || resolving || merging"
          @click="emit('accept', result)"
        >
          {{ accepting ? t('agent.accepting') : t('agent.acceptResult') }}
        </button>
        <template v-else>
          <span v-if="!merged" class="result-accepted">{{ t('agent.acceptedNotMerged') }}</span>
          <span v-else class="result-accepted">
            {{ t('agent.merged') }}
            <template v-if="result.mergedRevision">
              · <code>{{ result.mergedRevision.slice(0, 12) }}</code>
            </template>
          </span>
          <button
            v-if="!merged"
            class="primary-button"
            type="button"
            :disabled="merging || accepting || resolving"
            @click="emit('merge', result)"
          >
            {{ merging ? t('agent.merging') : t('agent.mergeResult') }}
          </button>
        </template>
      </div>
    </div>

    <div class="agent-result-overview">
      <section class="check-results">
        <article
          v-for="check in result.checks"
          :key="check.label + check.argv.join(' ')"
          class="check-result"
        >
          <strong
            >{{ check.label }} ·
            {{ check.status === 'passed' ? t('agent.passed') : t('agent.failed') }}</strong
          >
          <code>{{ check.argv.join(' ') }}</code>
          <pre v-if="check.output">{{ check.output }}</pre>
        </article>
      </section>
    </div>

    <div class="result-diff">
      <h4>{{ t('agent.diff') }}</h4>
      <AgentDiffView
        :task-id="taskId"
        :run-id="result.runId"
        :diff="result.diff"
        :files="result.files"
        :truncated="result.diffTruncated"
      />
    </div>
  </section>
</template>

<style scoped>
.agent-result-heading {
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.agent-result-heading > div:first-child {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.agent-result-heading h3 {
  margin: 0;
  font-size: 14px;
}
.result-check-status {
  font-size: 11px;
  padding: 3px 6px;
  border: 1px solid var(--border);
  border-radius: 5px;
  color: var(--dim);
}
.result-check-status.passed {
  color: var(--accent);
}
.result-check-status.failed {
  color: var(--error);
}
.agent-result-overview {
  margin: 6px 0;
}
.check-result {
  display: grid;
  grid-template-columns: minmax(140px, auto) minmax(0, 1fr);
  gap: 5px 10px;
  padding: 6px 0;
  font-size: 11px;
}
.check-result > code {
  margin: 0;
  overflow-wrap: anywhere;
}
.check-result > pre {
  grid-column: 1/-1;
  margin: 0;
}
.result-diff > h4 {
  display: none;
}

.agent-result-overview {
  grid-template-columns: minmax(0, 1fr);
}
</style>
