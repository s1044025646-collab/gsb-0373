import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { AppError } from "./errors.js";
import {
  computeDp,
  solve,
  validateChain,
  type DpTable,
} from "./core.js";
import type { MatrixSpec, VerifyReport } from "./types.js";

export interface ChainRow {
  id: number;
  name: string;
  created_at: string;
}

export interface VersionRow {
  id: number;
  chain_id: number;
  version: number;
  matrices: MatrixSpec[];
  created_at: string;
}

export class Store {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chains (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS chain_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chain_id INTEGER NOT NULL REFERENCES chains(id),
        version INTEGER NOT NULL,
        matrices TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(chain_id, version)
      );
      CREATE TABLE IF NOT EXISTS dp_results (
        version_id INTEGER PRIMARY KEY REFERENCES chain_versions(id),
        optimal_cost TEXT NOT NULL,
        expression TEXT NOT NULL,
        plan TEXT NOT NULL,
        steps TEXT NOT NULL,
        splits TEXT NOT NULL,
        ties TEXT NOT NULL,
        costs TEXT NOT NULL,
        left_assoc_cost TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS verifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version_id INTEGER NOT NULL REFERENCES chain_versions(id),
        candidate TEXT NOT NULL,
        report TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  private now(): string {
    return new Date().toISOString();
  }

  listChains(): (ChainRow & { versions: number })[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.name, c.created_at, COUNT(v.id) AS versions
         FROM chains c LEFT JOIN chain_versions v ON v.chain_id = c.id
         GROUP BY c.id ORDER BY c.id`,
      )
      .all() as unknown as (ChainRow & { versions: number })[];
    return rows;
  }

  getChain(chainId: number): ChainRow {
    const row = this.db
      .prepare("SELECT id, name, created_at FROM chains WHERE id = ?")
      .get(chainId) as unknown as ChainRow | undefined;
    if (!row) throw new AppError("NOT_FOUND", `链 ${chainId} 不存在`);
    return row;
  }

  listVersions(chainId: number): VersionRow[] {
    this.getChain(chainId);
    const rows = this.db
      .prepare(
        "SELECT id, chain_id, version, matrices, created_at FROM chain_versions WHERE chain_id = ? ORDER BY version",
      )
      .all(chainId) as unknown as (Omit<VersionRow, "matrices"> & { matrices: string })[];
    return rows.map((r) => ({ ...r, matrices: JSON.parse(r.matrices) as MatrixSpec[] }));
  }

  getVersion(chainId: number, version: number): VersionRow {
    this.getChain(chainId);
    const row = this.db
      .prepare(
        "SELECT id, chain_id, version, matrices, created_at FROM chain_versions WHERE chain_id = ? AND version = ?",
      )
      .get(chainId, version) as unknown as (Omit<VersionRow, "matrices"> & { matrices: string }) | undefined;
    if (!row) {
      throw new AppError("NOT_FOUND", `链 ${chainId} 的版本 ${version} 不存在`);
    }
    return { ...row, matrices: JSON.parse(row.matrices) as MatrixSpec[] };
  }

  // 导入尺寸链：内容不变则复用最新版本，变化则生成新版本；并立即计算 DP。
  // 校验失败抛错，不写入任何记录。
  importChain(name: string | null, chainId: number | null, rawMatrices: unknown): {
    chain: ChainRow;
    version: VersionRow;
    reused: boolean;
  } {
    const validated = validateChain(rawMatrices); // 失败输入不会保存
    const snapshot = JSON.stringify(validated.matrices);
    const now = this.now();

    let cid: number;
    if (chainId !== null) {
      this.getChain(chainId);
      cid = chainId;
    } else {
      const chainName = name ?? `chain-${now}`;
      this.db.prepare("INSERT INTO chains (name, created_at) VALUES (?, ?)").run(chainName, now);
      cid = Number(
        (this.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id,
      );
    }

    const latest = this.db
      .prepare(
        "SELECT id, version, matrices FROM chain_versions WHERE chain_id = ? ORDER BY version DESC LIMIT 1",
      )
      .get(cid) as unknown as { id: number; version: number; matrices: string } | undefined;

    if (latest && latest.matrices === snapshot) {
      return { chain: this.getChain(cid), version: this.getVersion(cid, latest.version), reused: true };
    }

    const nextVersion = latest ? latest.version + 1 : 1;
    this.db
      .prepare(
        "INSERT INTO chain_versions (chain_id, version, matrices, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(cid, nextVersion, snapshot, now);
    const versionRow = this.getVersion(cid, nextVersion);
    this.computeAndStore(versionRow);
    return { chain: this.getChain(cid), version: versionRow, reused: false };
  }

  private computeAndStore(version: VersionRow): void {
    const validated = validateChain(version.matrices);
    const result = solve(validated);
    const dp: DpTable = result.dp;
    this.db
      .prepare(
        `INSERT OR REPLACE INTO dp_results
         (version_id, optimal_cost, expression, plan, steps, splits, ties, costs, left_assoc_cost, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        version.id,
        result.optimalCost,
        result.expression,
        JSON.stringify(result.plan),
        JSON.stringify(result.steps),
        JSON.stringify(dp.split),
        JSON.stringify(dp.ties),
        JSON.stringify(dp.cost.map((row) => row.map((c) => c.toString()))),
        result.leftAssocCost,
        this.now(),
      );
  }

  getResult(chainId: number, version: number): {
    version: VersionRow;
    optimalCost: string;
    expression: string;
    plan: unknown;
    steps: unknown;
    leftAssocCost: string;
  } {
    const v = this.getVersion(chainId, version);
    const row = this.db
      .prepare("SELECT * FROM dp_results WHERE version_id = ?")
      .get(v.id) as unknown as Record<string, string> | undefined;
    if (!row) throw new AppError("NOT_FOUND", `链 ${chainId} 版本 ${version} 没有 DP 结果`);
    return {
      version: v,
      optimalCost: row.optimal_cost,
      expression: row.expression,
      plan: JSON.parse(row.plan),
      steps: JSON.parse(row.steps),
      leftAssocCost: row.left_assoc_cost,
    };
  }

  // 区间表（分页）：返回所有 len>=2 的 (i,j,cost,splitK,tiedKs)，按 len、i 排序
  getTable(chainId: number, version: number, offset: number, limit: number): {
    total: number;
    offset: number;
    limit: number;
    entries: unknown[];
  } {
    const v = this.getVersion(chainId, version);
    const row = this.db
      .prepare("SELECT costs, splits, ties FROM dp_results WHERE version_id = ?")
      .get(v.id) as unknown as { costs: string; splits: string; ties: string };
    const costs = JSON.parse(row.costs) as string[][];
    const splits = JSON.parse(row.splits) as number[][];
    const ties = JSON.parse(row.ties) as number[][][];
    const n = costs.length;
    const all: unknown[] = [];
    for (let len = 2; len <= n; len++) {
      for (let i = 0; i + len - 1 < n; i++) {
        const j = i + len - 1;
        all.push({ i, j, length: len, cost: costs[i][j], splitK: splits[i][j], tiedKs: ties[i][j] });
      }
    }
    return { total: all.length, offset, limit, entries: all.slice(offset, offset + limit) };
  }

  getDpForExplain(chainId: number, version: number): { matrices: MatrixSpec[]; dp: DpTable } {
    const v = this.getVersion(chainId, version);
    const validated = validateChain(v.matrices);
    return { matrices: v.matrices, dp: computeDp(validated) };
  }

  saveVerification(chainId: number, version: number, candidate: unknown, report: VerifyReport): number {
    const v = this.getVersion(chainId, version);
    this.db
      .prepare(
        "INSERT INTO verifications (version_id, candidate, report, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(v.id, JSON.stringify(candidate ?? null), JSON.stringify(report), this.now());
    return Number(
      (this.db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id,
    );
  }

  listVerifications(chainId: number, version: number): unknown[] {
    const v = this.getVersion(chainId, version);
    const rows = this.db
      .prepare(
        "SELECT id, candidate, report, created_at FROM verifications WHERE version_id = ? ORDER BY id",
      )
      .all(v.id) as unknown as { id: number; candidate: string; report: string; created_at: string }[];
    return rows.map((r) => ({
      id: r.id,
      candidate: JSON.parse(r.candidate),
      report: JSON.parse(r.report),
      createdAt: r.created_at,
    }));
  }
}

export function defaultDbPath(): string {
  const dir = process.env.MCM_DATA_DIR ?? path.join(process.cwd(), "data");
  return path.join(dir, "mcm.sqlite");
}
