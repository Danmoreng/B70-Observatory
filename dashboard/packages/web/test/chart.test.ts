// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { init, use } from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import { LineChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
} from 'echarts/components';
import { chartOption, seriesUnit, type ChartSeries } from '../src/lib/chart.js';
import { appendPoint, mergePoints, SERIES, type TimePoint } from '../src/lib/series.js';
use([SVGRenderer, LineChart, GridComponent, TooltipComponent, LegendComponent, DataZoomComponent]);

describe('ECharts time series', () => {
  it('assigns the production token series to their dedicated axes', () => {
    expect(
      SERIES.find((series) => series.key === 'vllm.prefill-compute-tokens-per-second')
    ).toMatchObject({
      label: 'Prefill',
      axis: 'left',
    });
    expect(
      SERIES.find((series) => series.key === 'vllm.generation-tokens-per-second')
    ).toMatchObject({ label: 'Decode', axis: 'right' });
  });

  it('renders GPU watts on a separate axis without clipping at 100 percent', () => {
    const series: ChartSeries[] = [
      {
        key: 'gpu.utilization-percent',
        label: 'GPU',
        color: '#6de2ae',
        unit: 'percent',
        points: [
          [0, 0],
          [60_000, 100],
        ],
      },
      {
        key: 'gpu.power-watts',
        label: 'Leistungsaufnahme',
        color: '#f5bd69',
        unit: 'watts',
        points: [
          [0, 17],
          [60_000, 250],
        ],
      },
    ];
    const chart = init(null, undefined, { renderer: 'svg', ssr: true, width: 800, height: 300 });
    try {
      const option = chartOption(series, 0, 60_000, true);
      chart.setOption(option);
      const svg = chart.renderToSVGString();
      expect(svg).toContain('Leistungsaufnahme');
      expect(svg).toContain('W');
      const top = chart.convertToPixel({ yAxisIndex: 0 }, 100) as number;
      const bottom = chart.convertToPixel({ yAxisIndex: 0 }, 0) as number;
      const powerY = chart.convertToPixel({ yAxisIndex: 1 }, 250) as number;
      expect(powerY).toBeGreaterThanOrEqual(top);
      expect(powerY).toBeLessThan(bottom);
      expect(seriesUnit(series[1]!, true)).toBe('W');
      const lines = option.series as import('echarts').LineSeriesOption[];
      expect(lines[1]?.yAxisIndex).toBe(1);
      const format = lines[1]?.tooltip?.valueFormatter;
      expect(typeof format).toBe('function');
      if (typeof format === 'function') expect(format(250, 0)).toBe('250.0 W');
    } finally {
      chart.dispose();
    }
  });

  it('scales Prefill on the left axis and Decode on the right axis with own ranges', () => {
    const prefill: ChartSeries = {
      key: 'vllm.prefill-compute-tokens-per-second',
      label: 'Prefill',
      color: '#76b9f6',
      unit: 'tokens_per_second',
      axis: 'left',
      points: [
        [0, 300],
        [60_000, 1200],
      ],
    };
    const decode: ChartSeries = {
      key: 'vllm.generation-tokens-per-second',
      label: 'Decode',
      color: '#6de2ae',
      unit: 'tokens_per_second',
      axis: 'right',
      points: [
        [0, 12],
        [60_000, 40],
      ],
    };
    const chart = init(null, undefined, { renderer: 'svg', ssr: true, width: 800, height: 300 });
    try {
      const option = chartOption([prefill, decode], 0, 60_000, false);
      chart.setOption(option);
      const axes = option.yAxis as Array<{
        name?: string;
        position?: string;
        splitLine?: { show?: boolean };
      }>;
      expect(axes).toHaveLength(2);
      expect(axes[0]?.name).toBe('Prefill (tok/s)');
      expect(axes[1]?.name).toBe('Decode (tok/s)');
      expect(axes[1]?.position).toBe('right');
      expect(axes[0]?.splitLine).not.toMatchObject({ show: false });
      expect(axes[1]?.splitLine).toMatchObject({ show: false });
      const lines = option.series as import('echarts').LineSeriesOption[];
      expect(lines[0]?.yAxisIndex).toBe(0);
      expect(lines[1]?.yAxisIndex).toBe(1);
      expect(lines[0]?.name).toBe('Prefill');
      expect(lines[1]?.name).toBe('Decode');
      for (const line of lines) {
        const format = line.tooltip?.valueFormatter;
        expect(typeof format).toBe('function');
        if (typeof format === 'function') expect(format(12, 0)).toBe('12.0 tok/s');
      }
      const svg = chart.renderToSVGString();
      expect(svg).toContain('Prefill (tok/s)');
      expect(svg).toContain('Decode (tok/s)');
      // Decode is ~40 tok/s while Prefill reaches ~1200 tok/s: on the shared
      // left scale 40 would sit at the bottom, on its own right axis it reaches
      // the top of the plot area.
      const top = chart.convertToPixel({ yAxisIndex: 0 }, 1200) as number;
      const bottom = chart.convertToPixel({ yAxisIndex: 0 }, 0) as number;
      const decodeOnLeft = chart.convertToPixel({ yAxisIndex: 0 }, 40) as number;
      const decodeOnRight = chart.convertToPixel({ yAxisIndex: 1 }, 40) as number;
      expect(decodeOnLeft).toBeGreaterThan(decodeOnRight);
      expect(decodeOnRight).toBeLessThanOrEqual(top);
      expect(decodeOnRight).toBeLessThan(bottom);
    } finally {
      chart.dispose();
    }
  });

  it('keeps both token axes and empty-state hints when no measurement exists', () => {
    const option = chartOption(
      [
        {
          key: 'vllm.prefill-compute-tokens-per-second',
          label: 'Prefill',
          color: '#76b9f6',
          unit: 'tokens_per_second',
          axis: 'left',
          points: [
            [0, null],
            [60_000, null],
          ],
        },
        {
          key: 'vllm.generation-tokens-per-second',
          label: 'Decode',
          color: '#6de2ae',
          unit: 'tokens_per_second',
          axis: 'right',
          points: [
            [0, null],
            [60_000, null],
          ],
        },
      ],
      0,
      60_000,
      false
    );
    const axes = option.yAxis as Array<{ name?: string }>;
    expect(axes.map((axis) => axis.name)).toEqual(['Prefill (tok/s)', 'Decode (tok/s)']);
    const lines = option.series as import('echarts').LineSeriesOption[];
    expect(lines[0]?.yAxisIndex).toBe(0);
    expect(lines[1]?.yAxisIndex).toBe(1);
    const format = lines[1]?.tooltip?.valueFormatter as
      ((value: unknown, index: number) => string) | undefined;
    expect(format?.(null, 0)).toBe('no measurement');
  });

  it('renders the real options and positions observations by elapsed time (R2)', () => {
    const chart = init(null, undefined, { renderer: 'svg', ssr: true, width: 800, height: 300 });
    try {
      chart.setOption(
        chartOption(
          [
            {
              key: 'gpu',
              label: 'GPU',
              color: '#6de2ae',
              points: [
                [0, 30],
                [10_000, 50],
                [60_000, 90],
              ],
            },
          ],
          0,
          60_000,
          true
        )
      );
      const svg = chart.renderToSVGString();
      expect(svg).toContain('<svg');
      expect(svg).toContain('GPU');
      expect(svg).toContain('100');
      const first = chart.convertToPixel({ xAxisIndex: 0 }, 0) as number;
      const second = chart.convertToPixel({ xAxisIndex: 0 }, 10_000) as number;
      const third = chart.convertToPixel({ xAxisIndex: 0 }, 60_000) as number;
      expect((third - first) / (second - first)).toBeCloseTo(6);
    } finally {
      chart.dispose();
    }
  });

  it('keeps live timestamps and missing buckets instead of fabricating zeroes', () => {
    const points = mergePoints(
      {
        series: 'gpu.utilization-percent',
        unit: 'percent',
        bucketSeconds: 60,
        buckets: [
          { atUtc: new Date(0).toISOString(), min: 20, max: 20, avg: 20, count: 1 },
          { atUtc: new Date(120_000).toISOString(), min: 30, max: 30, avg: 30, count: 1 },
        ],
      },
      [
        [125_000, 40],
        [140_000, null],
        [150_000, 60],
      ],
      0,
      180_000,
      60
    );
    expect(points).toEqual([
      [0, 20],
      [60_000, null],
      [125_000, 40],
      [140_000, null],
      [150_000, 60],
      [180_000, null],
    ]);
    const option = chartOption(
      [{ key: 'gpu', label: 'GPU', color: 'green', points }],
      0,
      180_000,
      true
    );
    expect(option.series).toEqual([
      expect.objectContaining({ connectNulls: false, smooth: false }),
    ]);
  });

  it('bounds buffers, deduplicates timestamps and preserves a real zero', () => {
    let points: TimePoint[] = Array.from({ length: 1800 }, (_, i) => [i, i]);
    points = appendPoint(points, [1800, 0]);
    points = appendPoint(points, [1799, null]);
    expect(points).toHaveLength(1800);
    expect(points[0]).toEqual([1, 1]);
    expect(points.slice(-2)).toEqual([
      [1799, null],
      [1800, 0],
    ]);
  });
});
