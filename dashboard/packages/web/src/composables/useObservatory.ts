import { computed, onMounted, onUnmounted, ref } from 'vue';
import type { HealthPayload, SystemSnapshot, VllmTelemetryPayload } from '@observatory/contracts';
import { t } from '../lib/i18n.js';
import {
  AuthFetchError,
  fetchAuthSession,
  HealthFetchError,
  login,
  logout,
  subscribeHealth,
} from '../lib/api.js';

export function useObservatory() {
  const auth = ref<'checking' | 'signed-out' | 'signing-in' | 'signed-in'>('checking');
  const authError = ref('');
  const signingOut = ref(false);
  /**
   * Operator browser-auth mode as announced by the server (`loginRequired`
   * on `GET /api/auth/session`). Absent (older servers) always means the
   * password flow applies. Only a confirmed `loginRequired: false` disables
   * the login screen and the sign-out action.
   */
  const loginRequired = ref(true);
  const connection = ref<'connecting' | 'connected' | 'reconnecting'>('connecting');
  /**
   * M5C: synchronisation phase of the current transport connection.
   * `resync` – the server could not continue from the last event id and
   * re-sends current snapshots; `replay` – missed events are being
   * re-delivered from the bounded journal. Cleared once the affected
   * sources are validated again.
   */
  const sync = ref<'none' | 'replay' | 'resync'>('none');
  const health = ref<HealthPayload | null>(null);
  const telemetry = ref<VllmTelemetryPayload | null>(null);
  const system = ref<SystemSnapshot | null>(null);
  const errors = ref({ health: '', telemetry: '', system: '', history: '', stream: '' });
  const fresh = ref({ health: false, telemetry: false, system: false });
  const metricRevision = ref(0);
  const requestRevision = ref(0);
  const now = ref(Date.now());
  let stop: (() => void) | undefined;
  let clock: ReturnType<typeof setInterval> | undefined;
  let disposed = false;
  let generation = 0;
  let checkingSession = false;
  let lastSessionCheck = -Infinity;

  function clear(): void {
    stop?.();
    stop = undefined;
    generation++;
    health.value = null;
    telemetry.value = null;
    system.value = null;
    sync.value = 'none';
    errors.value = { health: '', telemetry: '', system: '', history: '', stream: '' };
    fresh.value = { health: false, telemetry: false, system: false };
  }

  function expire(): void {
    clear();
    auth.value = 'signed-out';
    authError.value = t('auth.expired');
  }

  function handleDataError(error: unknown): void {
    if (error instanceof HealthFetchError && error.status === 401) expire();
  }

  async function checkSession(epoch: number): Promise<void> {
    if (checkingSession || Date.now() - lastSessionCheck < 5000) return;
    checkingSession = true;
    lastSessionCheck = Date.now();
    try {
      const session = await fetchAuthSession();
      if (!disposed && epoch === generation && !session.authenticated) expire();
    } catch {
      /* A disconnected server does not imply an expired session. */
    } finally {
      checkingSession = false;
    }
  }

  function startLive(): void {
    stop?.();
    const epoch = ++generation;
    connection.value = 'connecting';
    sync.value = 'none';
    fresh.value = { health: false, telemetry: false, system: false };
    const current = (): boolean => !disposed && epoch === generation;
    /**
     * M5C: the connection may be reported `connected` again once every
     * source the client holds is validated as current. Sources the server
     * explicitly did not replay (or re-sent fresh) keep their previous
     * freshness, so values that are genuinely up to date are not shown
     * as stale after a short, eventless interruption.
     */
    const settleConnection = (): void => {
      if (connection.value === 'connected') return;
      if (health.value === null || !fresh.value.health) return;
      if (telemetry.value !== null && !fresh.value.telemetry) return;
      if (system.value !== null && !fresh.value.system) return;
      connection.value = 'connected';
      sync.value = 'none';
    };
    stop = subscribeHealth({
      onHealth(payload) {
        if (!current()) return;
        health.value = payload;
        fresh.value.health = true;
        errors.value.health = '';
        settleConnection();
      },
      onTelemetry(payload) {
        if (!current()) return;
        telemetry.value = payload;
        fresh.value.telemetry = true;
        errors.value.telemetry = '';
        settleConnection();
      },
      onSystem(payload) {
        if (!current()) return;
        system.value = payload;
        fresh.value.system = true;
        errors.value.system = '';
        settleConnection();
      },
      onStream(notice) {
        if (!current()) return;
        errors.value.stream = '';
        if (notice.kind === 'resync') {
          // No provable continuity (restart, too-old/unknown/future id):
          // current snapshots are re-sent; nothing may be called current
          // until it arrives again.
          sync.value = 'resync';
          fresh.value = { health: false, telemetry: false, system: false };
          metricRevision.value++;
          requestRevision.value++;
          connection.value = 'connecting';
          return;
        }
        sync.value = 'replay';
        // The replay list is the server's proof of what was missed after
        // the client's last event id. Sources the client did *not* miss
        // still hold the server's current snapshot and become current
        // again; sources that are re-sent stay "last known" until their
        // replayed frame arrives.
        const types = new Set(notice.types);
        fresh.value.health = !types.has('health');
        fresh.value.telemetry = !types.has('telemetry');
        fresh.value.system = !types.has('system');
        if (types.has('history')) {
          metricRevision.value++;
          requestRevision.value++;
        }
        settleConnection();
      },
      onOpen() {
        if (!current()) return;
        // A new transport must be re-validated before any value is called
        // current again; the stream notice tells us what follows.
        sync.value = 'none';
        connection.value = 'connecting';
      },
      onHistory(payload) {
        if (!current()) return;
        errors.value.history = '';
        if (payload.resources.includes('metrics')) metricRevision.value++;
        if (payload.resources.includes('requests')) requestRevision.value++;
      },
      onError(error) {
        if (!current()) return;
        if (error.code === 'invalid_payload') {
          // Agent Cockpit owns a separate content-bearing stream and handles
          // its errors locally; it never reaches this shared subscription.
          if (error.source !== 'agent') errors.value[error.source ?? 'health'] = error.message;
          return;
        }
        connection.value = 'reconnecting';
        sync.value = 'none';
        fresh.value = { health: false, telemetry: false, system: false };
        void checkSession(epoch);
      },
    });
  }

  async function initialize(): Promise<void> {
    try {
      const session = await fetchAuthSession();
      if (disposed) return;
      loginRequired.value = session.loginRequired !== false;
      auth.value = session.authenticated ? 'signed-in' : 'signed-out';
      if (session.authenticated) startLive();
    } catch (error) {
      if (disposed) return;
      auth.value = 'signed-out';
      authError.value = error instanceof Error ? error.message : t('auth.connectionFailed');
    }
  }

  async function signIn(password: string): Promise<void> {
    auth.value = 'signing-in';
    authError.value = '';
    try {
      const session = await login(password);
      if (disposed) return;
      if (!session.authenticated) throw new AuthFetchError(t('auth.signInFailed'));
      auth.value = 'signed-in';
      startLive();
    } catch (error) {
      if (disposed) return;
      auth.value = 'signed-out';
      authError.value = error instanceof Error ? error.message : t('auth.signInFailed');
    }
  }

  async function signOut(): Promise<void> {
    // In operator browser mode `none` there is no session to revoke and the
    // server would report still authenticated – never show a fake sign-out.
    if (!loginRequired.value) return;
    if (signingOut.value) return;
    signingOut.value = true;
    authError.value = '';
    try {
      const session = await logout();
      if (session.authenticated) throw new AuthFetchError(t('auth.signOutUnconfirmed'));
      if (!disposed) {
        clear();
        auth.value = 'signed-out';
      }
    } catch (error) {
      if (error instanceof AuthFetchError && error.status === 401) expire();
      else authError.value = t('auth.signOutFailed');
    } finally {
      signingOut.value = false;
    }
  }

  const telemetryCurrent = computed(
    () =>
      connection.value === 'connected' &&
      fresh.value.telemetry &&
      !errors.value.telemetry &&
      telemetry.value?.sourceStatus === 'ok'
  );
  const systemCurrent = computed(
    () =>
      connection.value === 'connected' &&
      fresh.value.system &&
      !errors.value.system &&
      system.value?.sourceStatus === 'ok'
  );
  const uptime = computed(() =>
    health.value ? Math.max(0, (now.value - Date.parse(health.value.startedAt)) / 1000) : 0
  );
  const status = computed(() => {
    if (connection.value === 'reconnecting')
      return {
        tone: 'warn',
        title: t('status.disconnected.title'),
        detail: t('status.disconnected.detail'),
      };
    if (connection.value === 'connecting' && sync.value === 'resync')
      return {
        tone: 'warn',
        title: t('status.resync.title'),
        detail: t('status.resync.detail'),
      };
    if (connection.value === 'connecting' && sync.value === 'replay')
      return {
        tone: 'warn',
        title: t('status.replay.title'),
        detail: t('status.replay.detail'),
      };
    if (!fresh.value.health || health.value === null)
      return {
        tone: 'muted',
        title: t('status.connecting.title'),
        detail: t('status.connecting.detail'),
      };
    if (Object.values(errors.value).some(Boolean))
      return {
        tone: 'warn',
        title: t('status.incomplete.title'),
        detail: t('status.incomplete.detail'),
      };
    const failed = health.value.checks.filter((check) => check.status !== 'ok');
    if (failed.length === 1 && failed[0]?.name === 'vllm')
      return {
        tone: 'warn',
        title: t('status.vllmDown.title'),
        detail:
          t('status.vllmDown.intro') +
          (systemCurrent.value ? t('status.hardwareCurrent') : t('status.hardwareUnconfirmed')),
      };
    if (failed.length || health.value.status !== 'ok')
      return {
        tone: health.value.status === 'error' ? 'error' : 'warn',
        title: t('status.degraded.title'),
        detail:
          failed
            .map((check) =>
              check.name === 'vllm'
                ? `${t('check.vllm')}: ${check.message ?? t('status.unavailable')}`
                : (check.message ?? `${check.name}: ${t('status.unavailable')}`)
            )
            .join(' · ') || t('status.degradedDefault'),
      };
    const staleSources = [
      telemetry.value?.sourceStatus !== 'ok' && telemetry.value ? 'vLLM' : '',
      system.value?.sourceStatus !== 'ok' && system.value ? 'System / GPU' : '',
    ].filter(Boolean);
    if (staleSources.length)
      return {
        tone: 'warn',
        title: t('status.stale.title'),
        detail: t('status.stale.detail', { sources: staleSources.join(' & ') }),
      };
    return {
      tone: 'ok',
      title: t('status.ok.title'),
      detail: t('status.ok.detail'),
    };
  });

  onMounted(() => {
    void initialize();
    clock = setInterval(() => {
      now.value = Date.now();
    }, 1000);
  });
  onUnmounted(() => {
    disposed = true;
    clear();
    clearInterval(clock);
  });
  return {
    auth,
    authError,
    signingOut,
    loginRequired,
    signIn,
    signOut,
    expire,
    handleDataError,
    startLive,
    connection,
    sync,
    health,
    telemetry,
    system,
    errors,
    fresh,
    telemetryCurrent,
    systemCurrent,
    metricRevision,
    requestRevision,
    now,
    uptime,
    status,
  };
}
