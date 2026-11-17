/** One PC-wide daily boundary, including DST; independent of the server's TZ. */
export function berlinMinutes(now = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  return (
    Number(parts.find((p) => p.type === 'hour')?.value) * 60 +
    Number(parts.find((p) => p.type === 'minute')?.value)
  );
}
export function assertMayStartWork(now = new Date()): void {
  if (berlinMinutes(now) >= 22 * 60 + 45)
    throw new Error(
      'Ab 22:45 Uhr werden keine neuen Agentenarbeiten gestartet. Bitte morgen fortsetzen.'
    );
}
export function remainingWorkSeconds(now = new Date()): number {
  return Math.max(
    1,
    Math.min(70 * 60, (22 * 60 + 55 - berlinMinutes(now)) * 60 - now.getSeconds())
  );
}
