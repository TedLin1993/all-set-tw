import { DatabaseSync } from "node:sqlite";
import {
  generateSQLiteDrizzleJson,
  generateSQLiteMigration,
} from "drizzle-kit/api";
import { is, sql, SQL } from "drizzle-orm";
import { getTableConfig, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import * as schema from "../src/schema";
import { readMigrations } from "../testing/d1";

function parenthesized(sql: string, start: number) {
  let depth = 1;
  let quoted = false;
  for (let i = start; i < sql.length; i++) {
    if (sql[i] === "'") {
      if (quoted && sql[i + 1] === "'") {
        i++;
        continue;
      }
      quoted = !quoted;
    }
    if (quoted) continue;
    if (sql[i] === "(") depth++;
    if (sql[i] === ")" && --depth === 0) return sql.slice(start, i);
  }
  throw new Error("Unbalanced schema expression");
}

// Normalize SQL identifiers/whitespace only; string literals stay case-sensitive.
function normalizeSql(sql: string) {
  return sql
    .split(/('(?:[^']|'')*')/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/["`\[\]]/g, "")
            .replace(/\s+/g, "")
            .toLowerCase(),
    )
    .join("");
}

function inspect(database: DatabaseSync) {
  const tables = database
    .prepare(
      "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string; sql: string }>;
  return tables.map(({ name, sql }) => {
    const columns = database.prepare(`PRAGMA table_xinfo('${name}')`).all();
    const foreignKeys = database
      .prepare(`PRAGMA foreign_key_list('${name}')`)
      .all()
      .map(({ id: _id, ...fk }) => fk)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const checks = [...sql.matchAll(/\bCHECK\s*\(/gi)]
      .map((match) =>
        normalizeSql(parenthesized(sql, match.index + match[0].length)),
      )
      .sort();
    const generated = [...sql.matchAll(/\bAS\s*\(/gi)].map((match) =>
      normalizeSql(parenthesized(sql, match.index + match[0].length)),
    );
    const indexes = database
      .prepare(`PRAGMA index_list('${name}')`)
      .all()
      .map((index) => {
        const indexName = String(index.name);
        const indexSql = database
          .prepare("SELECT sql FROM sqlite_schema WHERE name = ?")
          .get(indexName)?.sql;
        const details = database
          .prepare(`PRAGMA index_xinfo('${indexName}')`)
          .all()
          .filter((column) => column.key === 1)
          .map(({ seqno, cid: _cid, ...column }) => ({ seqno, ...column }));
        // Kit represents inline UNIQUE constraints as named unique indexes.
        // Keep application index names, compare unnamed constraints by semantics.
        const isApplicationIndex = indexName.startsWith("idx_");
        let expression: string | undefined;
        let where: string | undefined;
        if (isApplicationIndex && typeof indexSql === "string") {
          const start = indexSql.indexOf("(");
          const body = parenthesized(indexSql, start + 1);
          expression = normalizeSql(body);
          where = normalizeSql(indexSql.slice(start + body.length + 2));
        }
        return {
          name: isApplicationIndex ? indexName : undefined,
          unique: index.unique,
          primary: index.origin === "pk",
          partial: index.partial,
          details,
          expression,
          where,
        };
      })
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { name, columns, foreignKeys, indexes, checks, generated };
  });
}

describe("Drizzle schema parity", () => {
  it("preserves the migrated schema, including generated columns and index semantics", async () => {
    const migrated = new DatabaseSync(":memory:");
    const generated = new DatabaseSync(":memory:");
    try {
      for (const migration of readMigrations()) migrated.exec(migration);
      const empty = await generateSQLiteDrizzleJson({});
      const current = await generateSQLiteDrizzleJson(schema);
      const statements = await generateSQLiteMigration(empty, current);
      // Kit 0.31 quotes SQLite expression index fragments as column names.
      // Compare table DDL from Kit, and index DDL from Drizzle's own SQL dialect.
      // Production continues to apply the existing reviewed SQL via Wrangler.
      for (const statement of statements.filter(
        (statement) => !/^CREATE (?:UNIQUE )?INDEX/i.test(statement),
      ))
        generated.exec(statement);
      const dialect = new SQLiteSyncDialect();
      for (const table of Object.values(schema)) {
        const config = getTableConfig(table);
        for (const index of config.indexes) {
          const { name, columns, unique, where } = index.config;
          const query = sql`CREATE ${unique ? sql`UNIQUE ` : sql``}INDEX ${sql.identifier(name)} ON ${sql.identifier(config.name)} (${sql.join(
            columns.map((column) =>
              is(column, SQL) ? column : sql.identifier(column.name),
            ),
            sql`, `,
          )})${where ? sql` WHERE ${where}` : sql``}`;
          generated.exec(dialect.sqlToQuery(query).sql);
        }
        for (const constraint of config.uniqueConstraints) {
          generated.exec(
            dialect.sqlToQuery(
              sql`CREATE UNIQUE INDEX ${sql.identifier(constraint.getName())} ON ${sql.identifier(config.name)} (${sql.join(
                constraint.columns.map((column) => sql.identifier(column.name)),
                sql`, `,
              )})`,
            ).sql,
          );
        }
      }
      const expected = inspect(migrated);
      expect(expected).toHaveLength(28);
      expect(inspect(generated)).toEqual(expected);
      expect(generated.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      // An unchanged schema must never produce an initialization migration.
      expect(
        await generateSQLiteMigration(
          current,
          await generateSQLiteDrizzleJson(schema),
        ),
      ).toEqual([]);
    } finally {
      migrated.close();
      generated.close();
    }
  });
});
