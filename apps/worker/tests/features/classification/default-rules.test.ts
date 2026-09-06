import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { resolveClassifications } from "../../../src/features/classification/service";

const migrationsDirectory = fileURLToPath(
  new URL("../../../../../packages/db/migrations/", import.meta.url),
);
const migrationFiles = readdirSync(migrationsDirectory)
  .filter((name) => name.endsWith(".sql"))
  .sort();
const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function createDatabase(before = "0040") {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  for (const file of migrationFiles.filter((name) => name < before)) {
    database.exec(readFileSync(`${migrationsDirectory}/${file}`, "utf8"));
  }
  return database;
}

function asD1(database: DatabaseSync) {
  return {
    prepare(sql: string) {
      let params: SQLInputValue[] = [];
      return {
        bind(...values: SQLInputValue[]) {
          params = values;
          return this;
        },
        async all() {
          return { results: database.prepare(sql).all(...params) };
        },
      };
    },
  } as unknown as D1Database;
}

describe("default classification rules", () => {
  it("classifies merchant and income descriptions using migrated rule priority", async () => {
    const cases: Array<[string, number, string]> = [
      ["OPENAI *CHATGPT SUBSCRO123456 SAN FR", -100, "software"],
      ["OPENAIO123456 SAN FR", -100, "software"],
      ["CURSOR, AI POWERED IDEO123456 CURSOR", -100, "software"],
      ["CLOUDFLAREO123456 SAN FR", -100, "software"],
      ["GOOGLE*CLOUD EXAMPLEO123456 CC GOO", -100, "software"],
      ["Microsoft 365", -100, "software"],
      ["中華電信股份有限公司個人家庭分TAIPEI", -100, "utilities"],
      ["遠傳電信股份有限公司TAIPEI", -100, "utilities"],
      ["信用卡消費折抵_遠傳電信股份有限公司", 100, "utilities"],
      ["轉帳代繳台灣電力電費", -100, "utilities"],
      ["瓦斯費", -100, "utilities"],
      ["利息存入", 100, "other-income"],
      ["利息", 100, "other-income"],
      ["證券股利匯款", 100, "other-income"],
      ["租金補貼轉入", 100, "other-income"],
      ["現金回饋", 100, "other-income"],
      ["利息", -100, "fee"],
      ["APPLE.COM/BILL", -100, "other"],
      ["GOOGLE*YOUTUBE", -100, "other"],
      ["電腦軟體/PXPAY PLUS CO LTD", -100, "other"],
      ["OPENAI 國外交易手續費", -100, "fee"],
      ["遠傳電信購機", -100, "other"],
      ["現金回饋退款", 100, "other"],
    ];
    const transactions = cases.map(([description, amount], index) => ({
      id: `transaction-${index}`,
      sourceId: `source-${index}`,
      description,
      amount,
    }));
    const results = await resolveClassifications(
      asD1(createDatabase()),
      transactions,
    );
    for (const [index, [description, , categoryId]] of cases.entries()) {
      expect(results.get(`transaction-${index}`)?.categoryId, description).toBe(
        categoryId,
      );
    }
    const sourceOnly = await resolveClassifications(asD1(createDatabase()), [
      {
        id: "source-only",
        sourceId: "openai",
        description: "未辨識交易",
        amount: -100,
      },
    ]);
    expect(sourceOnly.get("source-only")?.categoryId).toBe("other");
  });

  it("preserves an existing same-name category and supports migration reruns", async () => {
    const database = createDatabase("0038");
    database.exec(
      "INSERT INTO classification_categories VALUES ('user:software', '軟體服務', 15, 0, 'original', 'original')",
    );
    for (let run = 0; run < 2; run++) {
      for (const file of migrationFiles.filter(
        (name) => name >= "0038" && name < "0040",
      )) {
        database.exec(readFileSync(`${migrationsDirectory}/${file}`, "utf8"));
      }
    }
    expect(
      database
        .prepare(
          "SELECT category_id FROM classification_rules WHERE id = 'system:bank:software-keywords'",
        )
        .get()?.category_id,
    ).toBe("user:software");
    expect(
      database
        .prepare(
          "SELECT is_system FROM classification_categories WHERE id = 'user:software'",
        )
        .get()?.is_system,
    ).toBe(0);
  });

  it("keeps demo rules consistent with migrated defaults", () => {
    const database = createDatabase();
    const sql =
      "SELECT * FROM classification_rules WHERE id IN ('system:bank:software-keywords', 'system:bank:utilities-keywords', 'system:bank:other-income-keywords') ORDER BY id";
    const expected = database.prepare(sql).all();
    database.exec(
      readFileSync(
        new URL("../../../../../packages/db/seeds/demo.sql", import.meta.url),
        "utf8",
      ),
    );
    expect(expected).toHaveLength(3);
    expect(database.prepare(sql).all()).toEqual(expected);
  });
});
