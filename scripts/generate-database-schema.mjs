#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const databaseName = process.env.D1_DATABASE ?? "DB";
const outputPath = join(projectRoot, "docs", "database-schema.md");
const migrationsPath = join(projectRoot, "packages", "db", "migrations");
const metadataPath = join(
  projectRoot,
  "packages",
  "db",
  "schema-metadata.json",
);
const persistencePath = mkdtempSync(join(tmpdir(), "taiwan-fin-hub-schema-"));

function getWranglerEntry() {
  const configuredEntry = process.env.WRANGLER_ENTRY;
  if (configuredEntry) {
    return isAbsolute(configuredEntry)
      ? configuredEntry
      : resolve(projectRoot, configuredEntry);
  }

  const candidates = [
    join(projectRoot, "node_modules", "wrangler", "bin", "wrangler.js"),
    join(
      projectRoot,
      "apps",
      "worker",
      "node_modules",
      "wrangler",
      "bin",
      "wrangler.js",
    ),
  ];
  const entry = candidates.find((candidate) => existsSync(candidate));
  if (!entry) {
    throw new Error(
      "Cannot find Wrangler. Run npm install, or set WRANGLER_ENTRY to the Wrangler CLI entry point.",
    );
  }
  return entry;
}

function runWrangler(args) {
  const env = {
    ...process.env,
    // Migrations are applied to the temporary D1 below, so this command never
    // changes the developer's existing local database.
    CI: process.env.CI ?? "1",
    XDG_CONFIG_HOME:
      process.env.XDG_CONFIG_HOME ?? join(projectRoot, ".wrangler-config"),
  };

  try {
    return execFileSync(process.execPath, [getWranglerEntry(), ...args], {
      cwd: projectRoot,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr = error?.stderr?.toString().trim();
    const stdout = error?.stdout?.toString().trim();
    const details = [stderr, stdout].filter(Boolean).join("\n");
    throw new Error(
      `Wrangler command failed: wrangler ${args.join(" ")}\n${details}`,
      {
        cause: error,
      },
    );
  }
}

function runJsonQuery(sql) {
  const output = runWrangler([
    "d1",
    "execute",
    databaseName,
    "--local",
    "--persist-to",
    persistencePath,
    "--json",
    "--command",
    sql,
  ]);

  let response;
  try {
    response = JSON.parse(output);
  } catch (error) {
    throw new Error(
      `Wrangler returned invalid JSON for query: ${sql}\n${output}`,
      { cause: error },
    );
  }

  if (!Array.isArray(response)) {
    throw new Error(`Unexpected Wrangler response for query: ${sql}`);
  }

  return response.flatMap((result) => {
    if (Array.isArray(result)) return result;
    return Array.isArray(result?.results) ? result.results : [];
  });
}

function quoteLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function readSchemaMetadata() {
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read schema metadata at ${metadataPath}.`, {
      cause: error,
    });
  }

  if (
    !metadata ||
    typeof metadata.tables !== "object" ||
    metadata.tables === null
  ) {
    throw new Error(
      `Schema metadata at ${metadataPath} must contain a tables object.`,
    );
  }
  return metadata.tables;
}

function readSchemaObjects() {
  return runJsonQuery(`
    SELECT type, name, tbl_name AS table_name, sql
    FROM sqlite_schema
    WHERE type IN ('table', 'index', 'trigger', 'view')
      AND name NOT LIKE 'sqlite_%'
      AND name NOT GLOB '_cf_*'
      AND name <> 'd1_migrations'
    ORDER BY
      CASE type
        WHEN 'table' THEN 1
        WHEN 'index' THEN 2
        WHEN 'view' THEN 3
        WHEN 'trigger' THEN 4
        ELSE 5
      END,
      name
  `);
}

function readTableDetails(schemaObjects) {
  const tables = schemaObjects.filter((object) => object.type === "table");
  const indexes = schemaObjects.filter((object) => object.type === "index");
  const statements = [];

  for (const table of tables) {
    const tableLiteral = quoteLiteral(table.name);
    statements.push(
      `SELECT ${tableLiteral} AS __schema_table, 'columns' AS __schema_kind, cid, name, type, "notnull" AS not_null, dflt_value, pk, hidden FROM pragma_table_xinfo(${tableLiteral})`,
      `SELECT ${tableLiteral} AS __schema_table, 'foreign_keys' AS __schema_kind, id, seq, "table" AS referenced_table, "from" AS from_column, "to" AS to_column, on_update, on_delete, match FROM pragma_foreign_key_list(${tableLiteral})`,
      `SELECT ${tableLiteral} AS __schema_table, 'index_list' AS __schema_kind, seq, name, "unique", origin, partial FROM pragma_index_list(${tableLiteral}) WHERE name NOT GLOB 'sqlite_*'`,
    );

    // index_info needs the index name as an argument, so generate one query
    // per explicit index while still executing all metadata queries in one
    // Wrangler process.
    for (const index of indexes.filter(
      (candidate) => candidate.table_name === table.name,
    )) {
      statements.push(
        `SELECT ${tableLiteral} AS __schema_table, 'index_columns' AS __schema_kind, ${quoteLiteral(
          index.name,
        )} AS index_name, seqno, cid, name FROM pragma_index_info(${quoteLiteral(index.name)})`,
      );
    }
  }

  const metadataRows = runJsonQuery(statements.join(";\n"));
  const detailsByTable = new Map(
    tables.map((table) => [
      table.name,
      { columns: [], foreignKeys: [], indexes: [] },
    ]),
  );

  for (const row of metadataRows) {
    const details = detailsByTable.get(row.__schema_table);
    if (!details) continue;

    if (row.__schema_kind === "columns") {
      details.columns.push({
        cid: row.cid,
        name: row.name,
        type: row.type,
        notnull: row.not_null,
        dflt_value: row.dflt_value,
        pk: row.pk,
        hidden: row.hidden,
      });
    } else if (row.__schema_kind === "foreign_keys") {
      details.foreignKeys.push({
        from: row.from_column,
        table: row.referenced_table,
        to: row.to_column,
        on_update: row.on_update,
        on_delete: row.on_delete,
      });
    } else if (row.__schema_kind === "index_list") {
      details.indexes.push({
        name: row.name,
        unique: row.unique,
        partial: row.partial,
        columns: [],
      });
    } else if (row.__schema_kind === "index_columns") {
      const index = details.indexes.find(
        (candidate) => candidate.name === row.index_name,
      );
      index?.columns.push({ name: row.name, seqno: row.seqno, cid: row.cid });
    }
  }

  for (const table of tables) {
    const details = detailsByTable.get(table.name);
    for (const index of details.indexes) {
      const schemaIndex = indexes.find(
        (candidate) =>
          candidate.table_name === table.name && candidate.name === index.name,
      );
      if (schemaIndex) Object.assign(index, { sql: schemaIndex.sql });
    }
  }

  return detailsByTable;
}

function markdownValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  return String(value).replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

function normalizeSql(sql) {
  return sql
    .trim()
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

function validateMetadata(detailsByTable, metadataTables) {
  const errors = [];
  const actualTableNames = [...detailsByTable.keys()];
  const metadataTableNames = Object.keys(metadataTables);

  for (const tableName of actualTableNames) {
    const tableMetadata = metadataTables[tableName];
    if (!tableMetadata || typeof tableMetadata !== "object") {
      errors.push(`missing table description: ${tableName}`);
      continue;
    }
    if (
      typeof tableMetadata.description !== "string" ||
      tableMetadata.description.trim() === ""
    ) {
      errors.push(`missing table description: ${tableName}`);
    }

    const actualColumns = detailsByTable
      .get(tableName)
      .columns.map((column) => column.name);
    const describedColumns = Object.keys(tableMetadata.columns ?? {});
    for (const columnName of actualColumns) {
      const description = tableMetadata.columns?.[columnName];
      if (typeof description !== "string" || description.trim() === "") {
        errors.push(`missing column description: ${tableName}.${columnName}`);
      }
    }
    for (const columnName of describedColumns) {
      if (!actualColumns.includes(columnName)) {
        errors.push(`unknown column description: ${tableName}.${columnName}`);
      }
    }
  }

  for (const tableName of metadataTableNames) {
    if (!actualTableNames.includes(tableName)) {
      errors.push(`unknown table description: ${tableName}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      `Schema metadata is incomplete or stale:\n- ${errors.join("\n- ")}`,
    );
  }
}

function renderColumns(columns, columnMetadata) {
  const rows = columns.map((column) => {
    const generated =
      column.hidden === 2 ? "virtual" : column.hidden === 3 ? "stored" : "—";
    return `| ${column.cid + 1} | \`${markdownValue(column.name)}\` | ${markdownValue(
      columnMetadata[column.name],
    )} | ${markdownValue(column.type)} | ${column.notnull ? "NO" : "YES"} | ${markdownValue(
      column.dflt_value,
    )} | ${column.pk || "—"} | ${generated} |`;
  });

  return [
    "| 順序 | 欄位 | 意義 | SQLite type | 可為 NULL | 預設值 | PK 順序 | Generated |",
    "| ---: | --- | --- | --- | :---: | --- | ---: | --- |",
    ...rows,
  ].join("\n");
}

function renderForeignKeys(foreignKeys) {
  if (foreignKeys.length === 0) return "—";
  return [
    "| 欄位 | 參照表 | 參照欄位 | ON UPDATE | ON DELETE |",
    "| --- | --- | --- | --- | --- |",
    ...foreignKeys.map(
      (foreignKey) =>
        `| \`${markdownValue(foreignKey.from)}\` | \`${markdownValue(
          foreignKey.table,
        )}\` | \`${markdownValue(foreignKey.to)}\` | ${markdownValue(
          foreignKey.on_update,
        )} | ${markdownValue(foreignKey.on_delete)} |`,
    ),
  ].join("\n");
}

function renderIndexes(indexes) {
  if (indexes.length === 0) return "—";
  return [
    "| Index | Unique | Partial | 欄位 | 定義 |",
    "| --- | :---: | :---: | --- | --- |",
    ...indexes.map((index) => {
      const columns = index.columns
        .filter((column) => column.name !== null && column.name !== undefined)
        .map((column) => `\`${column.name}\``)
        .join(", ");
      return `| \`${markdownValue(index.name)}\` | ${index.unique ? "是" : "否"} | ${
        index.partial ? "是" : "否"
      } | ${columns || "—"} | ${index.sql ? `\`${markdownValue(index.sql)}\`` : "—"} |`;
    }),
  ].join("\n");
}

function renderSchema(schemaObjects, migrations, metadataTables) {
  const tables = schemaObjects.filter((object) => object.type === "table");
  const detailsByTable = readTableDetails(schemaObjects);
  validateMetadata(detailsByTable, metadataTables);
  const otherObjects = schemaObjects.filter(
    (object) => object.type !== "table" && object.type !== "index",
  );
  const totalIndexes = schemaObjects.filter(
    (object) => object.type === "index",
  ).length;

  const lines = [
    "# Database Schema",
    "",
    "> 此文件由 `npm run db:schema:docs` 自動產生，請勿直接編輯。",
    ">",
    "> Schema 來源是套用 `packages/db/migrations/*.sql` 後的隔離 local D1；不包含任何正式環境資料。",
    "> Wrangler 管理的 `d1_migrations` metadata table 刻意省略。",
    "> Table 與欄位的業務語意來自 `packages/db/schema-metadata.json`。",
    "",
    "## 目錄",
    "",
    `- Tables：${tables.length}`,
    `- Explicit indexes：${totalIndexes}`,
    `- Other objects：${otherObjects.length}`,
    `- Migrations：${migrations.length}`,
    "",
    "## Tables",
    "",
    "| Table | 用途 | Columns | Foreign keys | Indexes |",
    "| --- | --- | ---: | ---: | ---: |",
    ...tables.map((table) => {
      const details = detailsByTable.get(table.name);
      return `| [\`${table.name}\`](#${table.name}) | ${markdownValue(
        metadataTables[table.name].description,
      )} | ${
        details.columns.length
      } | ${details.foreignKeys.length} | ${details.indexes.length} |`;
    }),
    "",
  ];

  for (const table of tables) {
    const details = detailsByTable.get(table.name);
    lines.push(
      `### \`${table.name}\``,
      "",
      `> 用途：${markdownValue(metadataTables[table.name].description)}`,
      ...(metadataTables[table.name].notes
        ? [`> 注意：${markdownValue(metadataTables[table.name].notes)}`]
        : []),
      "",
      "#### Columns",
      "",
      renderColumns(details.columns, metadataTables[table.name].columns),
      "",
      "#### Foreign keys",
      "",
      renderForeignKeys(details.foreignKeys),
      "",
      "#### Indexes",
      "",
      renderIndexes(details.indexes),
      "",
      "#### DDL",
      "",
      "```sql",
      table.sql ? normalizeSql(table.sql) : "-- DDL unavailable",
      "```",
      "",
    );
  }

  lines.push("## Other database objects", "");
  if (otherObjects.length === 0) {
    lines.push("目前沒有 view 或 trigger。", "");
  } else {
    lines.push("| Type | Name | Definition |", "| --- | --- | --- |");
    for (const object of otherObjects) {
      lines.push(
        `| ${object.type} | \`${markdownValue(object.name)}\` | ${markdownValue(object.sql)} |`,
      );
    }
    lines.push("");
  }

  lines.push("## Migration history", "");
  lines.push(
    "Migration 是 schema 演進的 source of truth；若要了解某欄位的變更原因，請從對應 migration 檔案與 Git history 追查。",
    "",
    ...migrations.map(
      (migration) =>
        `- [\`${migration}\`](../packages/db/migrations/${migration})`,
    ),
    "",
    "## 程式碼導覽",
    "",
    "- Feature-specific SQL：`apps/worker/src/features/*/repository.ts`",
    "- 共用 D1 能力：`packages/db/src/`",
    "- 共用資料契約：`packages/core/`",
    "",
  );

  return lines.join("\n");
}

function listMigrations() {
  return readdirSync(migrationsPath)
    .filter((file) => file.endsWith(".sql"))
    .sort((left, right) =>
      left.localeCompare(right, undefined, { numeric: true }),
    );
}

try {
  runWrangler([
    "d1",
    "migrations",
    "apply",
    databaseName,
    "--local",
    "--persist-to",
    persistencePath,
  ]);

  const schemaObjects = readSchemaObjects();
  const migrations = listMigrations();
  const metadataTables = readSchemaMetadata();
  writeFileSync(
    outputPath,
    `${renderSchema(schemaObjects, migrations, metadataTables).trimEnd()}\n`,
    "utf8",
  );
  console.log(`Generated ${outputPath}`);
} finally {
  rmSync(persistencePath, { recursive: true, force: true });
}
