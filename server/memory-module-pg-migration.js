const SCHEMA_LOCK_KEY = 'cochpia:memory-module:schema:v1';

export async function applyMemoryModuleSchema(pool, { schema, pgvectorSql = '' } = {}) {
  if (!pool || typeof pool.connect !== 'function') throw new TypeError('A pg Pool is required');
  if (!String(schema || '').trim()) throw new TypeError('Memory Module schema SQL is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [SCHEMA_LOCK_KEY]);
    await client.query(schema);
    if (String(pgvectorSql || '').trim()) await client.query(pgvectorSql);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export { SCHEMA_LOCK_KEY };
