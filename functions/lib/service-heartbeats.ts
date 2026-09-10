const MAX_ERROR_LENGTH = 500;

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? "unknown error");
  return message.replace(/[\r\n\t]+/g, " ").slice(0, MAX_ERROR_LENGTH);
}

async function write(db: D1Database | undefined, sql: string, values: unknown[]): Promise<void> {
  if (!db || typeof db.prepare !== "function") return;
  try {
    await db.prepare(sql).bind(...values).run();
  } catch (error) {
    console.error("[service-heartbeat] write failed", error instanceof Error ? error.message : String(error));
  }
}

export function recordHeartbeatAttempt(db: D1Database | undefined, component: string, release?: string): Promise<void> {
  return write(db, `
    INSERT INTO service_heartbeats (component, status, last_attempted_at, release, updated_at)
    VALUES (?, 'waiting', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    ON CONFLICT(component) DO UPDATE SET
      last_attempted_at = excluded.last_attempted_at,
      release = COALESCE(excluded.release, service_heartbeats.release),
      updated_at = excluded.updated_at
  `, [component, release ?? null]);
}

export function recordHeartbeatSuccess(db: D1Database | undefined, component: string, release?: string): Promise<void> {
  return write(db, `
    INSERT INTO service_heartbeats
      (component, status, last_attempted_at, last_succeeded_at, release, consecutive_successes, consecutive_failures, updated_at)
    VALUES (?, 'healthy', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?, 1, 0, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    ON CONFLICT(component) DO UPDATE SET
      status = CASE
        WHEN service_heartbeats.status = 'issue' AND service_heartbeats.consecutive_successes + 1 < 2 THEN 'issue'
        ELSE 'healthy'
      END,
      last_attempted_at = excluded.last_attempted_at,
      last_succeeded_at = excluded.last_succeeded_at,
      last_error = CASE
        WHEN service_heartbeats.status = 'issue' AND service_heartbeats.consecutive_successes + 1 < 2
          THEN service_heartbeats.last_error
        ELSE NULL
      END,
      release = COALESCE(excluded.release, service_heartbeats.release),
      consecutive_successes = service_heartbeats.consecutive_successes + 1,
      consecutive_failures = 0,
      updated_at = excluded.updated_at
  `, [component, release ?? null]);
}

export function recordHeartbeatFailure(
  db: D1Database | undefined,
  component: string,
  error: unknown,
  release?: string,
): Promise<void> {
  return write(db, `
    INSERT INTO service_heartbeats
      (component, status, last_attempted_at, last_failed_at, last_error, release, consecutive_successes, consecutive_failures, updated_at)
    VALUES (?, 'issue', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?, ?, 0, 1, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    ON CONFLICT(component) DO UPDATE SET
      status = 'issue',
      last_attempted_at = excluded.last_attempted_at,
      last_failed_at = excluded.last_failed_at,
      last_error = excluded.last_error,
      release = COALESCE(excluded.release, service_heartbeats.release),
      consecutive_successes = 0,
      consecutive_failures = service_heartbeats.consecutive_failures + 1,
      updated_at = excluded.updated_at
  `, [component, safeError(error), release ?? null]);
}
