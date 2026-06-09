import pg from 'pg';

const DEFAULT_DB_URL = 'postgres://watson:watson-workout-db@127.0.0.1:5433/workouts';

export const DB_URL = process.env.WORKOUT_DB_URL ?? DEFAULT_DB_URL;

export const pool = new pg.Pool({ connectionString: DB_URL, max: 5 });

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(text, params as never[]);
  return result.rows;
}

export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Dedicated LISTEN connection for workout_changes notifications.
 * Reconnects with backoff if the connection drops.
 */
export function startChangeListener(onChange: (payload: string) => void): void {
  let backoffMs = 1000;

  const connect = () => {
    const client = new pg.Client({ connectionString: DB_URL });

    client.on('notification', (msg) => {
      if (msg.channel === 'workout_changes' && msg.payload) {
        onChange(msg.payload);
      }
    });

    const scheduleReconnect = () => {
      setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 30_000);
    };

    client.on('error', () => {
      client.end().catch(() => {});
    });
    client.on('end', scheduleReconnect);

    client
      .connect()
      .then(() => client.query('LISTEN workout_changes'))
      .then(() => {
        backoffMs = 1000;
        console.log('[workout-ui] listening for workout_changes');
      })
      .catch((err) => {
        console.error('[workout-ui] listener connect failed:', err.message);
        client.end().catch(() => {});
      });
  };

  connect();
}
