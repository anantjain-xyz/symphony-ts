import { createDb, type Db } from '@symphony/shared';
import { env } from './env';

// Persist the Drizzle client across HMR reloads in dev so each save doesn't
// leak a fresh postgres-js pool. In prod (one process, no HMR) the global
// branch is never taken.
const globalForDb = globalThis as unknown as { __symphonyDb?: Db };

export const db: Db = globalForDb.__symphonyDb ?? createDb(env.DATABASE_URL, { max: 5 });
if (process.env.NODE_ENV !== 'production') globalForDb.__symphonyDb = db;
