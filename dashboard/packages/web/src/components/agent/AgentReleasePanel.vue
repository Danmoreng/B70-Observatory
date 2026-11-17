<script setup lang="ts">
import { computed } from 'vue';
import type {
  AgentRunResult,
  DeploymentState,
  ReleaseJob,
  ReleaseJobStatus,
} from '@observatory/contracts';
import { formatShortDateTime } from '../../lib/format.js';
import { t } from '../../lib/i18n.js';

const props = defineProps<{
  result?: AgentRunResult;
  releases: ReleaseJob[];
  capable: boolean;
  releasing: boolean;
  deploying?: boolean;
  deployment?: DeploymentState;
}>();

defineEmits<{
  prepare: [result: AgentRunResult];
  activate: [release: ReleaseJob];
  rollback: [];
}>();

const merged = computed(
  () =>
    props.result !== undefined &&
    props.result.acceptedRevision === props.result.resultRevision &&
    props.result.mergedAt !== undefined
);
const pending = computed(() =>
  props.releases.some((release) => ['queued', 'building', 'activating'].includes(release.status))
);

function statusLabel(status: ReleaseJobStatus): string {
  if (status === 'queued') return t('agent.releaseQueued');
  if (status === 'building') return t('agent.releaseBuilding');
  if (status === 'prepared') return t('agent.releasePrepared');
  if (status === 'activating') return t('agent.releaseActivating');
  if (status === 'active') return t('agent.releaseActive');
  if (status === 'rolled_back') return t('agent.releaseRolledBack');
  return t('agent.releaseFailed');
}
</script>

<template>
  <section class="release-panel" role="tabpanel">
    <div class="panel release-action">
      <div>
        <h3>{{ t('agent.releaseChecks') }}</h3>
        <p v-if="result">
          {{ t('agent.releaseRevision') }} · <code>{{ result.resultRevision.slice(0, 12) }}</code>
        </p>
        <p v-if="!capable">{{ t('agent.releaseUnavailable') }}</p>
        <p v-else-if="!merged">{{ t('agent.releaseNeedsMerge') }}</p>
      </div>
      <button
        v-if="result && capable && merged"
        class="primary-button"
        type="button"
        :disabled="releasing || pending"
        @click="$emit('prepare', result)"
      >
        {{ releasing || pending ? t('agent.releasePreparing') : t('agent.prepareRelease') }}
      </button>
    </div>

    <div v-if="deployment" class="panel release-action">
      <div>
        <h3>{{ t('agent.deployment') }}</h3>
        <p v-if="deployment.current">
          {{ t('agent.runningRevision') }} ·
          <code>{{ deployment.current.revision.slice(0, 12) }}</code>
        </p>
        <p v-if="deployment.message" class="release-reason">{{ deployment.message }}</p>
      </div>
      <button
        v-if="deployment.previous"
        class="quiet-button"
        type="button"
        :disabled="deploying || deployment.status === 'activating'"
        @click="$emit('rollback')"
      >
        {{ deploying ? t('agent.releaseActivating') : t('agent.rollbackRelease') }}
      </button>
    </div>

    <article v-for="release in releases" :key="release.id" class="panel release-job">
      <header>
        <div>
          <strong>{{ statusLabel(release.status) }}</strong>
          <p>
            <code>{{ release.revision.slice(0, 12) }}</code>
          </p>
        </div>
        <time :datetime="release.updatedAt">{{ formatShortDateTime(release.updatedAt) }}</time>
      </header>
      <p v-if="release.reason" class="release-reason">{{ release.reason }}</p>
      <p v-if="release.status === 'prepared'">{{ t('agent.releasePreparedHint') }}</p>
      <p v-if="release.artifactDigest" class="release-digest">
        SHA-256 · <code>{{ release.artifactDigest }}</code>
      </p>
      <details v-if="release.buildLog">
        <summary>{{ t('agent.checks') }}</summary>
        <pre>{{ release.buildLog }}</pre>
      </details>
      <button
        v-if="release.status === 'prepared'"
        class="primary-button"
        type="button"
        :disabled="deploying"
        @click="$emit('activate', release)"
      >
        {{ deploying ? t('agent.releaseActivating') : t('agent.activateRelease') }}
      </button>
    </article>
  </section>
</template>
