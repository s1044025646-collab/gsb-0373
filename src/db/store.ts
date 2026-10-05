import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { CandidateVerifyResult, OptimalPlan } from "../core/types.js";
import { serialize } from "../core/serialize.js";

/**
 * SQLite 持久化。链用内容哈希做版本：
 * 同一项目同一尺寸快照复用同一版本；任何修改（含同名矩阵改尺寸）都生成新版本，
 * 历史版本保留，可按 versionId 查询原编号。
 */
export interface ChainVersionRow {
  version_id: string;
  name: string | null;
  n: number;
  dims_json: string;
  matrices_json: string;
  plan_json: string;
  total_cost: string;
  created_at: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chain_versions (
        version_id TEXT PRIMARY KEY,
        name TEXT,
        n INTEGER NOT NULL,
        dims_json TEXT NOT NULL,
        matrices_json TEXT NOT NULL,
        plan_json TEXT NOT NULL,
        total_cost TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS verifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id TEXT NOT NULL REFERENCES chain_versions(version_id),
        valid INTEGER NOT NULL,
        optimal INTEGER NOT NULL,
        total_cost TEXT,
        optimal_cost TEXT,
        cost_gap TEXT,
        error_code TEXT,
        message TEXT,
        candidate_json TEXT NOT NULL,
        result_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  }

  /** 维度快照哈希（node 内置 crypto，无第三方依赖） */
  static snapshotId(
    name: string | null,
    matrices: { id: string; rows: bigint; cols: bigint }[],
  ): string {
    const { createHash } = require("node:crypto") as typeof import("node:crypto");
    const payload = JSON.stringify({
      name,
      m: matrices.map((m) => [m.id, m.rows.toString(), m.cols.toString()]),
    });
    return createHash("sha256").update(payload).digest("hex").slice(0, 16);
  }

  /**
   * 保存或复用版本。只有 DP 成功后才调用，因此失败输入不会落库为成功规划。
   * 返回版本与是否新建。
   */
  upsertPlan(name: string | null, plan: OptimalPlan): { versionId: string; created: boolean } {
    const versionId = Store.snapshotId(name, plan.matrices);
    const existing = this.db
      .prepare("SELECT version_id FROM chain_versions WHERE version_id = ?")
      .get(versionId);
    if (existing) return { versionId, created: false };

    this.db
      .prepare(
        `INSERT INTO chain_versions
         (version_id, name, n, dims_json, matrices_json, plan_json, total_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        versionId,
        name,
        plan.matrices.length,
        JSON.stringify(serialize(plan.dims)),
        JSON.stringify(serialize(plan.matrices)),
        JSON.stringify(serialize(plan)),
        plan.totalCost.toString(),
      );
    return { versionId, created: true };
  }

  getVersion(versionId: string): ChainVersionRow | undefined {
    return this.db
      .prepare("SELECT * FROM chain_versions WHERE version_id = ?")
      .get(versionId) as ChainVersionRow | undefined;
  }

  listVersions(limit = 100): ChainVersionRow[] {
    return this.db
      .prepare("SELECT * FROM chain_versions ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(limit) as ChainVersionRow[];
  }

  saveVerification(versionId: string, candidate: unknown, result: CandidateVerifyResult): number {
    const info = this.db
      .prepare(
        `INSERT INTO verifications
         (version_id, valid, optimal, total_cost, optimal_cost, cost_gap, error_code, message,
          candidate_json, result_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        versionId,
        result.valid ? 1 : 0,
        result.optimal ? 1 : 0,
        result.totalCost?.toString() ?? null,
        result.optimalCost?.toString() ?? null,
        result.costGap?.toString() ?? null,
        result.errorCode ?? null,
        result.message ?? null,
        JSON.stringify(serialize(candidate)),
        JSON.stringify(serialize(result)),
      );
    return Number(info.lastInsertRowid);
  }

  listVerifications(versionId: string | null, limit = 50): unknown[] {
    const select = versionId
      ? this.db
          .prepare(
            "SELECT * FROM verifications WHERE version_id = ? ORDER BY id DESC LIMIT ?",
          )
          .all(versionId, limit)
      : this.db.prepare("SELECT * FROM verifications ORDER BY id DESC LIMIT ?").all(limit);
    return select as unknown[];
  }

  close(): void {
    this.db.close();
  }
}
