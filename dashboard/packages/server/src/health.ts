import {
  SERVICE_NAME,
  type HealthCheck,
  type HealthPayload,
  type ServiceStatus,
} from '@observatory/contracts';

/**
 * Builds the `GET /api/health` payload.
 *
 * M1 exposes the server itself as the only check; later milestones add
 * gateway/vLLM/GPU/database checks and the overall status becomes the worst
 * individual status.
 */
export interface HealthInputs {
  version: string;
  startedAt: Date;
  checks?: ReadonlyArray<HealthCheck>;
}

const STATUS_SEVERITY: Record<ServiceStatus, number> = {
  ok: 0,
  degraded: 1,
  error: 2,
};

function deriveStatus(checks: ReadonlyArray<HealthCheck>): ServiceStatus {
  return checks.reduce<ServiceStatus>(
    (worst, check) =>
      STATUS_SEVERITY[check.status] > STATUS_SEVERITY[worst] ? check.status : worst,
    'ok'
  );
}

export function buildHealthPayload(now: Date, inputs: HealthInputs): HealthPayload {
  const checks: HealthCheck[] =
    inputs.checks && inputs.checks.length > 0
      ? [...inputs.checks]
      : [{ name: 'server', status: 'ok' }];

  return {
    service: SERVICE_NAME,
    status: deriveStatus(checks),
    version: inputs.version,
    startedAt: inputs.startedAt.toISOString(),
    timestamp: now.toISOString(),
    uptimeSeconds: Math.max(0, Math.floor((now.getTime() - inputs.startedAt.getTime()) / 1000)),
    checks,
  };
}
