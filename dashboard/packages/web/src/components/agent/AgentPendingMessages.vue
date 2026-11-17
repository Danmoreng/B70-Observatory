<script setup lang="ts">
import { computed } from 'vue';
import { steeringStatusLabel } from '../../lib/labels.js';
import { t } from '../../lib/i18n.js';

/** Delivery entries relevant to the current run (subset of DurableSteering). */
export interface SteeringDeliveryView {
  id: string;
  text: string;
  status: string;
  confirmedAt?: string;
}

const props = defineProps<{
  pendingSteering?: number;
  deliveries: SteeringDeliveryView[];
}>();
const pendingCount = computed(() => props.pendingSteering ?? 0);
const awaitingDelivery = computed(() =>
  props.deliveries.filter(
    (entry) => entry.confirmedAt === undefined && entry.status !== 'cancelled'
  )
);
</script>

<template>
  <section
    v-if="awaitingDelivery.length || pendingCount > 0"
    class="pending-messages"
    :aria-label="t('agent.sentMessages')"
  >
    <p class="pending-messages-heading">{{ t('agent.sentMessages') }}</p>
    <p v-if="pendingCount > 0" class="queue-note" role="status">
      {{ t('agent.steerPending', { count: pendingCount }) }}
    </p>
    <ul v-if="awaitingDelivery.length" class="steering-deliveries">
      <li v-for="entry in awaitingDelivery" :key="entry.id">
        <span>{{ entry.text }}</span>
        <small :class="entry.status">{{ steeringStatusLabel(entry.status) }}</small>
      </li>
    </ul>
  </section>
</template>
