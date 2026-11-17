import { describe, expect, it } from 'vitest';
import { probeIntelGpu, type GpuProbeIo } from '../../src/telemetry/gpu-probe.js';

/**
 * The probe is exercised through an in-memory sysfs mock so the tests run
 * on any machine and never touch the real /sys (the probe itself is
 * strictly read-only anyway).
 */
function mockSysfs(files: Record<string, string>, dirs: Record<string, string[]>): GpuProbeIo {
  return {
    listDirectory: async (path) => {
      const entries = dirs[path];
      return entries === undefined ? undefined : [...entries];
    },
    readFile: async (path) => files[path] ?? undefined,
  };
}

const drmDirs = {
  '/sys/class/drm': ['card0', 'card1', 'version'],
};

describe('probeIntelGpu (read-only sysfs probe)', () => {
  it('reports unavailable when no xe-driver card exists', async () => {
    const io = mockSysfs(
      {
        '/sys/class/drm/card0/device/uevent': 'DRIVER=amdgpu\nPCI_ID=1002:164E\n',
      },
      {
        '/sys/class/drm': ['card0'],
        '/sys/class/drm/card0/device/hwmon': ['hwmon1'],
      }
    );
    const result = await probeIntelGpu(io);
    expect(result.available).toBe(false);
    expect((result as { reason: string }).reason).toContain('Kein Intel-GPU');
  });

  it('reports unavailable with the concrete missing attributes for an incomplete xe interface', async () => {
    // Mirrors the Intel GPU on this machine: per-channel temperatures and a
    // cumulative energy counter, but no utilization / power / VRAM values.
    const io = mockSysfs(
      {
        '/sys/class/drm/card0/device/uevent': 'DRIVER=xe\nPCI_ID=8086:E223\n',
        '/sys/class/drm/card0/device/hwmon/hwmon2/name': 'xe\n',
        '/sys/class/drm/card0/device/hwmon/hwmon2/temp10_input': '76000\n',
        '/sys/class/drm/card0/device/hwmon/hwmon2/temp10_label': 'vram_ch_4\n',
        '/sys/class/drm/card0/device/hwmon/hwmon2/energy1_input': '56112410034\n',
        '/sys/class/drm/card0/device/hwmon/hwmon2/energy1_label': 'card\n',
      },
      {
        ...drmDirs,
        '/sys/class/drm/card0/device/hwmon': ['hwmon2'],
      }
    );
    const result = await probeIntelGpu(io);
    expect(result.available).toBe(false);
    const reason = (result as { reason: string }).reason;
    expect(reason).toContain('gpu_busy_percent');
    expect(reason).toContain('power1_input');
    expect(reason).toContain('mem_info_vram_used');
    // Temperature was present, so it must not be listed as missing.
    expect(reason).not.toContain('temp1_input');
  });

  it('reports available when the complete, unit-unambiguous attribute set exists', async () => {
    const io = mockSysfs(
      {
        '/sys/class/drm/card0/device/uevent': 'DRIVER=xe\n',
        '/sys/class/drm/card0/device/hwmon/hwmon1/name': 'xe\n',
        '/sys/class/drm/card0/device/hwmon/hwmon1/gpu_busy_percent': '42\n',
        '/sys/class/drm/card0/device/hwmon/hwmon1/power1_input': '55000\n',
        '/sys/class/drm/card0/device/hwmon/hwmon1/temp1_input': '54500\n',
        '/sys/class/drm/card0/device/hwmon/hwmon1/mem_info_vram_used': '128849018880\n',
      },
      {
        ...drmDirs,
        '/sys/class/drm/card0/device/hwmon': ['hwmon1'],
      }
    );
    expect(await probeIntelGpu(io)).toEqual({ available: true });
  });

  it('treats non-numeric attribute values as missing', async () => {
    const io = mockSysfs(
      {
        '/sys/class/drm/card0/device/uevent': 'DRIVER=xe\n',
        '/sys/class/drm/card0/device/hwmon/hwmon1/name': 'xe\n',
        '/sys/class/drm/card0/device/hwmon/hwmon1/gpu_busy_percent': 'N/A\n',
        '/sys/class/drm/card0/device/hwmon/hwmon1/power1_input': '40000\n',
        '/sys/class/drm/card0/device/hwmon/hwmon1/temp1_input': '50000\n',
        '/sys/class/drm/card0/device/hwmon/hwmon1/mem_info_vram_used': '8192\n',
      },
      {
        ...drmDirs,
        '/sys/class/drm/card0/device/hwmon': ['hwmon1'],
      }
    );
    const result = await probeIntelGpu(io);
    expect(result.available).toBe(false);
    expect((result as { reason: string }).reason).toContain('gpu_busy_percent');
  });

  it('reports unavailable when /sys/class/drm is unreadable (never throws)', async () => {
    const io: GpuProbeIo = {
      listDirectory: async () => undefined,
      readFile: async () => undefined,
    };
    const result = await probeIntelGpu(io);
    expect(result.available).toBe(false);
    expect((result as { reason: string }).reason).toContain('GPU-Probe fehlgeschlagen');
  });

  it('keeps the reason within the contract bound (256 chars)', async () => {
    const io = mockSysfs(
      {
        '/sys/class/drm/card0/device/uevent': `DRIVER=xe\n` + 'x'.repeat(400),
        '/sys/class/drm/card0/device/hwmon/hwmon1/name': 'xe\n',
      },
      {
        ...drmDirs,
        '/sys/class/drm/card0/device/hwmon': ['hwmon1'],
      }
    );
    const result = await probeIntelGpu(io);
    expect(result.available).toBe(false);
    expect((result as { reason: string }).reason.length).toBeLessThanOrEqual(256);
  });
});
