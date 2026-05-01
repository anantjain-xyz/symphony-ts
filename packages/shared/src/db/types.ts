import type { SchemaMap } from './schema';

/**
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
