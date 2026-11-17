/**
 * Telemetry domain (M2): SQLite/WAL persistence with versioned migrations,
 * a repository layer with runtime-validated inputs, and the retention
 * primitive. No HTTP surface yet – the gateway (M3) and collectors (M4)
 * will be the producers of these repositories.
 */
export {
  DatabaseError,
  DbContractError,
  isSqliteBusyError,
  sqliteErrcode,
  SQLITE_BUSY,
  type DatabaseErrorCode,
} from './errors.js';
export {
  openDatabase,
  closeDatabase,
  databaseHealthCheck,
  type OpenDatabaseOptions,
} from './database.js';
export { applyMigrations, MIGRATIONS, type Migration } from './migrations.js';
export {
  RequestRepository,
  type StoredRequest,
  type StoredRequestEvent,
  type RequestFilter,
} from './requests.js';
export { MetricRepository, type StoredMetricSample, type MetricQuery } from './metrics.js';
export {
  ServiceEventRepository,
  type StoredServiceEvent,
  type ServiceEventFilter,
} from './service-events.js';
export { pruneOlderThan, retentionCutoffUtc, type RetentionCounts } from './retention.js';
export { AuthSessionRepository, type AuthSessionRecord } from './auth-sessions.js';
export {
  NewRequestSchema,
  RequestResultSchema,
  RequestEventSchema,
  RequestEventTypeSchema,
  RequestStatusSchema,
  MetricSampleSchema,
  MetricSourceSchema,
  ServiceEventSchema,
  type NewRequest,
  type RequestResult,
  type RequestEvent,
  type RequestStatus,
  type MetricSample,
  type ServiceEvent,
  type ServiceName,
  type ServiceSeverity,
} from './contracts.js';
