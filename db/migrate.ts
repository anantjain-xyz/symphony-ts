#!/usr/bin/env tsx
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const ADVISORY_LOCK = 0xc0ffee;

const url = process.env.DATABASE_URL;
if (!url) {
  process.stderr.write('DATABASE_URL is required\n');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, 'migrations');

const sql = postgres(url, { max: 1, onnotice: () => {} });

async function main() {
  await sql`select pg_advisory_lock(${ADVISORY_LOCK})`;
  await sql`
    create table if not exists _migrations (
      filename text primary key,
      applied_at timestamptz not null default now()
    )
  `;
  const rows = await sql<{ filename: string }[]>`select filename from _migrations`;
  const applied = new Set(rows.map((r) => r.filename));
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

  let n = 0;
  for (const f of files) {
    if (applied.has(f)) continue;
    const body = await readFile(join(migrationsDir, f), 'utf8');
    const firstLine = body.split('\n', 1)[0]?.trim() ?? '';
    const noTxn = firstLine === '-- @notxn';

    process.stdout.write(`applying ${f} ... `);
    if (noTxn) {
      await sql.unsafe(body, [], { simple: true });
      await sql`insert into _migrations (filename) values (${f})`;
    } else {
      await sql.begin(async (tx) => {
        await tx.unsafe(body, [], { simple: true });
        await tx`insert into _migrations (filename) values (${f})`;
      });
    }
    process.stdout.write('ok\n');
    n++;
  }
  await sql`select pg_advisory_unlock(${ADVISORY_LOCK})`;
  process.stdout.write(`done. applied ${n} new migration(s).\n`);
}

main()
  .catch((err) => {
    process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
    process.exitCode = 1;
  })
  .finally(() => sql.end());
