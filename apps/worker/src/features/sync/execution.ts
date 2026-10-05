import type { Env } from "../../platform/env";
import { syncLockGuardStatement, type SyncLockOwner } from "../../db/sync-jobs";
import { startSyncLockHeartbeat, SYNC_MAX_DURATION_MS } from "./lock";

export type SyncEnv = Env & { syncSignal?: AbortSignal };

export class SyncLockLostError extends Error {
  constructor() {
    super("同步鎖已失效，請重新同步。");
  }
}
export class SyncTimeoutError extends Error {
  constructor() {
    super("同步已超過執行期限，已停止，請重新同步。");
  }
}

/** 僅包裝這次同步的 binding，沒有跨 request 的可變狀態。 */
export function createSyncExecution(
  env: Env,
  owner: SyncLockOwner,
  options: {
    deadline?: number;
    chunk?: {
      connectorId: "einvoice" | "tdcc";
      owner: string;
      renew: () => Promise<boolean>;
    };
  } = {},
) {
  const controller = new AbortController();
  const signal = controller.signal;
  const abort = (error: Error) => {
    if (!signal.aborted) controller.abort(error);
  };
  if (options.deadline !== undefined && options.deadline <= Date.now())
    abort(new SyncTimeoutError());
  const timeout = setTimeout(
    () => abort(new SyncTimeoutError()),
    Math.max(
      0,
      (options.deadline ?? Date.now() + SYNC_MAX_DURATION_MS) - Date.now(),
    ),
  );
  const stopHeartbeat = startSyncLockHeartbeat(
    env.DB,
    owner.lockRowId,
    owner.runId,
    abort,
  );
  const chunkHeartbeat = options.chunk
    ? setInterval(() => {
        void options
          .chunk!.renew()
          .then((renewed) => {
            if (!renewed) abort(new SyncLockLostError());
          })
          .catch(() => abort(new SyncLockLostError()));
      }, 60_000)
    : undefined;
  const scopedEnv: SyncEnv = {
    ...env,
    DB: guardSyncDatabase(env.DB, owner, signal, options.chunk, abort),
    BROWSER: env.BROWSER
      ? new Proxy(env.BROWSER, {
          get(target, key) {
            if (key === "syncSignal") return signal;
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        })
      : env.BROWSER,
    syncSignal: signal,
  };
  return {
    env: scopedEnv,
    async run<T>(task: (env: SyncEnv) => Promise<T>): Promise<T> {
      signal.throwIfAborted();
      let onAbort: () => void = () => {};
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([
          Promise.resolve().then(() => task(scopedEnv)),
          aborted,
        ]);
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
    stop() {
      clearTimeout(timeout);
      stopHeartbeat();
      if (chunkHeartbeat !== undefined) clearInterval(chunkHeartbeat);
      abort(new SyncLockLostError());
    },
  };
}

/** 寫入與 owner 檢查在同一個 batch；失鎖／逾時後拒絕遲到結果。 */
export function guardSyncDatabase(
  db: D1Database,
  owner: SyncLockOwner,
  signal: AbortSignal,
  chunk?: { connectorId: "einvoice" | "tdcc"; owner: string | null },
  onLost?: (error: SyncLockLostError) => void,
): D1Database {
  const statements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  function protect<T extends D1Database | D1DatabaseSession>(binding: T): T {
    async function batch(input: D1PreparedStatement[]) {
      signal.throwIfAborted();
      try {
        return (
          await binding.batch<Record<string, unknown>>([
            syncLockGuardStatement(binding, owner, chunk),
            ...input.map((statement) => statements.get(statement) ?? statement),
          ])
        ).slice(1);
      } catch (error) {
        signal.throwIfAborted();
        try {
          await syncLockGuardStatement(binding, owner, chunk).run();
        } catch {
          const lost = new SyncLockLostError();
          onLost?.(lost);
          throw lost;
        }
        throw error;
      }
    }
    function statement(
      original: D1PreparedStatement,
      readOnly: boolean,
    ): D1PreparedStatement {
      const wrapped = new Proxy(original, {
        get(target, key) {
          if (key === "bind")
            return (...values: unknown[]) =>
              statement(target.bind(...values), readOnly);
          if (["run", "all", "first", "raw"].includes(String(key)))
            return async (...args: unknown[]) => {
              signal.throwIfAborted();
              if (readOnly)
                return Reflect.apply(
                  Reflect.get(target, key, target),
                  target,
                  args,
                );
              const result = (await batch([target]))[0]!;
              if (key === "first")
                return args[0]
                  ? (result.results[0]?.[String(args[0])] ?? null)
                  : (result.results[0] ?? null);
              if (key === "raw")
                return result.results.map((row) =>
                  Object.values(row as Record<string, unknown>),
                );
              return result;
            };
          const value = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      statements.set(wrapped, original);
      return wrapped;
    }
    return new Proxy(binding, {
      get(target, key) {
        if (key === "prepare")
          return (query: string) =>
            statement(target.prepare(query), /^\s*SELECT\b/i.test(query));
        if (key === "batch") return batch;
        if (key === "withSession" && "withSession" in target)
          return (bookmark?: string) => protect(target.withSession(bookmark));
        if (key === "exec")
          return () => {
            throw new Error("同步寫入必須使用 prepared statements 或 batch。");
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }
  return protect(db);
}
