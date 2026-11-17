<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { use, connect, disconnect } from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
} from 'echarts/components';
import VChart from 'vue-echarts';
import 'vue-echarts/style.css';
import { chartOption, seriesUnit, type ChartSeries } from '../lib/chart.js';
import { t } from '../lib/i18n.js';
import { formatNumber, formatTimestamp } from '../lib/format.js';
use([
  CanvasRenderer,
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
]);
const props = defineProps<{
  title: string;
  subtitle?: string;
  series: ChartSeries[];
  from: number;
  to: number;
  percent?: boolean;
  loading?: boolean;
  error?: string;
  group?: string;
}>();
defineEmits<{ retry: [] }>();
const ready = ref(false);
const tableOpen = ref(false);
const units = computed(() =>
  [...new Set(props.series.map((item) => seriesUnit(item, props.percent ?? false)))].join(' / ')
);
const option = computed(() =>
  chartOption(props.series, props.from, props.to, props.percent ?? false)
);
const hasData = computed(() =>
  props.series.some((series) => series.points.some((point) => point[1] !== null))
);
onMounted(() => {
  ready.value = true;
  if (props.group) connect(props.group);
});
onUnmounted(() => {
  if (props.group) disconnect(props.group);
});
</script>

<template>
  <section class="chart-panel" :aria-label="title" :aria-busy="loading">
    <div class="section-heading">
      <div>
        <h2>{{ title }}</h2>
        <p v-if="subtitle" class="section-caption">{{ subtitle }}</p>
      </div>
      <span class="chart-unit">{{ units }}</span>
    </div>
    <div class="chart-canvas">
      <VChart
        v-if="ready"
        :option="option"
        :group="group"
        autoresize
        :update-options="{ replaceMerge: ['series'] }"
        class="echart"
        aria-hidden="true"
      />
      <p v-if="!hasData" class="chart-empty">
        {{ loading ? t('chart.loading') : t('chart.empty') }}
      </p>
    </div>
    <p v-if="error" class="inline-error" role="status">
      {{ error }}
      <button type="button" class="text-button" @click="$emit('retry')">
        {{ t('chart.retry') }}
      </button>
    </p>
    <details class="chart-data" @toggle="tableOpen = ($event.target as HTMLDetailsElement).open">
      <summary>{{ t('chart.table') }}</summary>
      <div v-if="tableOpen" class="table-scroll">
        <table>
          <caption>
            {{
              t('chart.tableCaption', { title })
            }}
          </caption>
          <thead>
            <tr>
              <th scope="col">{{ t('chart.time') }}</th>
              <th scope="col">{{ t('chart.series') }}</th>
              <th scope="col">{{ t('chart.value') }}</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="item in series" :key="item.key">
              <tr v-for="point in item.points" :key="`${item.key}-${point[0]}`">
                <td>{{ formatTimestamp(point[0]) }}</td>
                <td>{{ item.label }}</td>
                <td>
                  {{
                    point[1] === null
                      ? t('chart.noMeasurement')
                      : `${formatNumber(point[1])} ${seriesUnit(item, percent ?? false)}`
                  }}
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </details>
  </section>
</template>
