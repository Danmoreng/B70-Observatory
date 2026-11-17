import type { EChartsOption } from 'echarts';
import { formatClock, formatFixed } from './format.js';
import { t } from './i18n.js';
import type { TimePoint } from './series.js';

export interface ChartSeries {
  key: string;
  label: string;
  color: string;
  points: TimePoint[];
  unit?: 'percent' | 'ratio' | 'watts' | 'tokens_per_second';
  axis?: 'left' | 'right';
}
export function seriesUnit(series: ChartSeries, percent: boolean): string {
  if (series.unit === 'watts') return 'W';
  if (series.unit === 'percent' || series.unit === 'ratio') return '%';
  return percent ? '%' : 'tok/s';
}
export function chartOption(
  series: ChartSeries[],
  from: number,
  to: number,
  percent: boolean
): EChartsOption {
  const hasPower = series.some((item) => item.unit === 'watts');
  const hasTokens = series.some((item) => item.unit === 'tokens_per_second');
  const dualAxis = hasPower || hasTokens;
  const leftColor = hasTokens
    ? (series.find((item) => item.unit === 'tokens_per_second' && item.axis !== 'right')?.color ??
      '#76b9f6')
    : '#a9b8c8';
  const rightColor = hasPower
    ? '#f5bd69'
    : (series.find((item) => item.axis === 'right')?.color ?? '#6de2ae');
  return {
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { fontFamily: 'system-ui, sans-serif', color: '#a9b8c8' },
    grid: { left: 48, right: dualAxis ? 56 : 18, top: 28, bottom: 70 },
    tooltip: {
      trigger: 'axis',
      renderMode: 'richText',
      backgroundColor: '#1b2633',
      borderColor: '#344354',
      textStyle: { color: '#eef5fa' },
      valueFormatter: (value) =>
        value === null || value === undefined
          ? t('chart.noMeasurement')
          : `${formatFixed(Number(value))} ${percent ? '%' : 'tok/s'}`,
    },
    legend: {
      bottom: 0,
      textStyle: { color: '#a9b8c8' },
      icon: 'roundRect',
      itemWidth: 14,
      itemHeight: 3,
    },
    xAxis: {
      type: 'time',
      min: from,
      max: to,
      splitNumber: 3,
      axisTick: { show: false },
      axisLine: { lineStyle: { color: '#304050' } },
      axisLabel: {
        hideOverlap: true,
        formatter: (value) => formatClock(new Date(value).toISOString()).slice(0, 5),
      },
      axisPointer: {
        label: { formatter: (params) => formatClock(new Date(Number(params.value)).toISOString()) },
      },
    },
    yAxis: [
      {
        type: 'value',
        min: 0,
        ...(percent ? { max: 100 } : {}),
        name: percent ? '%' : hasTokens ? 'Prefill (tok/s)' : 'tok/s',
        splitNumber: 3,
        splitLine: { lineStyle: { color: '#24303e' } },
        axisLabel: {
          ...(hasTokens ? { color: leftColor } : {}),
          formatter: (value: number) => formatFixed(value, 0),
        },
        ...(hasTokens ? { nameTextStyle: { color: leftColor } } : {}),
      },
      ...(dualAxis
        ? [
            {
              type: 'value' as const,
              position: 'right' as const,
              min: 0,
              name: hasPower ? 'W' : 'Decode (tok/s)',
              splitNumber: 3,
              splitLine: { show: false },
              axisLabel: {
                color: rightColor,
                formatter: (value: number) => formatFixed(value, 0),
              },
              nameTextStyle: { color: rightColor },
            },
          ]
        : []),
    ],
    dataZoom: [
      { type: 'inside', filterMode: 'none' },
      {
        type: 'slider',
        height: 14,
        bottom: 31,
        borderColor: 'transparent',
        backgroundColor: '#1b2531',
        fillerColor: '#375c5544',
        handleStyle: { color: '#6de2ae' },
        textStyle: { color: '#a9b8c8' },
        showDetail: false,
      },
    ],
    series: series.map((s) => ({
      id: s.key,
      name: s.label,
      type: 'line',
      data: s.points,
      yAxisIndex: s.axis === 'right' ? 1 : s.unit === 'watts' ? 1 : 0,
      tooltip: {
        valueFormatter: (value) =>
          value === null || value === undefined
            ? t('chart.noMeasurement')
            : `${formatFixed(Number(value))} ${seriesUnit(s, percent)}`,
      },
      smooth: false,
      connectNulls: false,
      showSymbol: true,
      symbolSize: 3,
      lineStyle: { width: 2, color: s.color },
      itemStyle: { color: s.color },
      areaStyle: { color: s.color, opacity: 0.045 },
      emphasis: { focus: 'series' },
    })),
  };
}
