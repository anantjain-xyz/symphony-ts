import type { SchemaMap } from './schema';

/**
 * Compatibility shim for the `Tables<'name'>` / `TablesInsert<'name'>` /
 * `TablesUpdate<'name'>` pattern that consumers used to import from the
 * Supabase-generated `db-types.ts`. Maps a public table name (snake_case) to
 * the Drizzle-inferred row type so callers don't have to import the table
 * objects directly.
 *
 * `Tables<T>` works for both base tables and views; insert/update apply only
 * to base tables (views have no `$inferInsert`).
 */
export type Tables<T extends keyof SchemaMap> = SchemaMap[T]['$inferSelect'];

type InsertableKeys = {
  [K in keyof SchemaMap]: SchemaMap[K] extends { $inferInsert: unknown } ? K : never;
}[keyof SchemaMap];

export type TablesInsert<T extends InsertableKeys> = SchemaMap[T] extends {
  $inferInsert: infer I;
}
  ? I
  : never;

export type TablesUpdate<T extends InsertableKeys> = Partial<TablesInsert<T>>;
