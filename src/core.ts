import { AppError } from "./errors.js";
import type {
  CandidateNode,
  MatrixSpec,
  PlanNode,
  SolveResult,
  Step,
  VerifyReport,
} from "./types.js";

export const MAX_CHAIN_LENGTH = 60;
export const MAX_DIMENSION = 1_000_000_000; // 公开尺寸上限：1e9

export interface ValidatedChain {
  matrices: MatrixSpec[];
  dims: bigint[]; // 长度 n+1，p[i] = 矩阵 i 的行数，p[n] = 最后一个矩阵的列数
}

export function validateChain(input: unknown): ValidatedChain {
  if (!Array.isArray(input)) {
    throw new AppError("BAD_REQUEST", "输入必须是矩阵数组");
  }
  if (input.length === 0) {
    throw new AppError("EMPTY_CHAIN", "空链被拒绝：至少需要一个矩阵");
  }
  if (input.length > MAX_CHAIN_LENGTH) {
    throw new AppError(
      "CHAIN_TOO_LONG",
      `链长度 ${input.length} 超过上限 ${MAX_CHAIN_LENGTH}`,
    );
  }
  const seen = new Set<string>();
  const matrices: MatrixSpec[] = [];
  for (let i = 0; i < input.length; i++) {
    const m = input[i] as Record<string, unknown>;
    if (m === null || typeof m !== "object") {
      throw new AppError("BAD_REQUEST", `第 ${i + 1} 个矩阵不是对象`);
    }
    const id = m.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new AppError("BAD_REQUEST", `第 ${i + 1} 个矩阵缺少字符串编号 id`);
    }
    if (seen.has(id)) {
      throw new AppError("DUPLICATE_MATRIX_ID", `矩阵编号 "${id}" 重复`);
    }
    seen.add(id);
    for (const key of ["rows", "cols"] as const) {
      const v = m[key];
      if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
        throw new AppError(
          "INVALID_DIMENSION",
          `矩阵 "${id}" 的 ${key} 必须是正整数，收到 ${String(v)}`,
        );
      }
      if (v > MAX_DIMENSION) {
        throw new AppError(
          "DIMENSION_LIMIT",
          `矩阵 "${id}" 的 ${key}=${v} 超过公开上限 ${MAX_DIMENSION}`,
        );
      }
    }
    matrices.push({ id, rows: m.rows as number, cols: m.cols as number });
  }
  for (let i = 0; i < matrices.length - 1; i++) {
    const a = matrices[i];
    const b = matrices[i + 1];
    if (a.cols !== b.rows) {
      throw new AppError(
        "INCOMPATIBLE_BOUNDARY",
        `相邻尺寸不相容：矩阵 "${a.id}"（${a.rows}x${a.cols}）的列数 ${a.cols} 与矩阵 "${b.id}"（${b.rows}x${b.cols}）的行数 ${b.rows} 不一致（边界 ${i + 1}/${i + 2}）`,
        { boundary: i + 1, left: a, right: b },
      );
    }
  }
  const dims: bigint[] = [BigInt(matrices[0].rows)];
  for (const m of matrices) dims.push(BigInt(m.cols));
  return { matrices, dims };
}

export interface DpTable {
  n: number;
  cost: bigint[][]; // cost[i][j]，0-based 含端点
  split: number[][]; // split[i][j] = 最优 k（i <= k < j），单矩阵为 -1
  ties: number[][][]; // ties[i][j] = 达到最优的所有 k（升序）
}

export function computeDp(chain: ValidatedChain): DpTable {
  const n = chain.matrices.length;
  const p = chain.dims;
  const cost: bigint[][] = [];
  const split: number[][] = [];
  const ties: number[][][] = [];
  for (let i = 0; i < n; i++) {
    cost.push(new Array<bigint>(n).fill(0n));
    split.push(new Array<number>(n).fill(-1));
    ties.push(Array.from({ length: n }, () => []));
  }
  for (let len = 2; len <= n; len++) {
    for (let i = 0; i + len - 1 < n; i++) {
      const j = i + len - 1;
      let best: bigint | null = null;
      const bestKs: number[] = [];
      for (let k = i; k < j; k++) {
        const c = cost[i][k] + cost[k + 1][j] + p[i] * p[k + 1] * p[j + 1];
        if (best === null || c < best) {
          best = c;
          bestKs.length = 0;
          bestKs.push(k);
        } else if (c === best) {
          bestKs.push(k);
        }
      }
      cost[i][j] = best as bigint;
      split[i][j] = bestKs[0]; // 并列取最小 k，保证确定性
      ties[i][j] = bestKs;
    }
  }
  return { n, cost, split, ties };
}

export function buildPlan(chain: ValidatedChain, dp: DpTable): PlanNode {
  const { matrices } = chain;
  const rec = (i: number, j: number): PlanNode => {
    if (i === j) {
      const m = matrices[i];
      return { kind: "leaf", id: m.id, rows: m.rows, cols: m.cols };
    }
    const k = dp.split[i][j];
    const left = rec(i, k);
    const right = rec(k + 1, j);
    return {
      kind: "mul",
      left,
      right,
      rows: left.rows,
      cols: right.cols,
      cost: (BigInt(left.rows) * BigInt(left.cols) * BigInt(right.cols)).toString(),
    };
  };
  return rec(0, matrices.length - 1);
}

export function planExpression(chain: ValidatedChain, dp: DpTable): string {
  const { matrices } = chain;
  const rec = (i: number, j: number): string => {
    if (i === j) return matrices[i].id;
    const k = dp.split[i][j];
    return `(${rec(i, k)} x ${rec(k + 1, j)})`;
  };
  return rec(0, matrices.length - 1);
}

export function planSteps(plan: PlanNode): Step[] {
  const steps: Step[] = [];
  const desc = (node: PlanNode): string =>
    node.kind === "leaf" ? node.id : `T${node.rows}x${node.cols}`;
  const rec = (node: PlanNode): void => {
    if (node.kind === "leaf") return;
    rec(node.left);
    rec(node.right);
    steps.push({
      step: steps.length + 1,
      left: desc(node.left),
      right: desc(node.right),
      resultRows: node.rows,
      resultCols: node.cols,
      cost: node.cost,
    });
  };
  rec(plan);
  return steps;
}

export function planTotalCost(plan: PlanNode): bigint {
  if (plan.kind === "leaf") return 0n;
  return planTotalCost(plan.left) + planTotalCost(plan.right) + BigInt(plan.cost);
}

export function leftAssocCost(chain: ValidatedChain): bigint {
  const { matrices } = chain;
  if (matrices.length < 2) return 0n;
  let rows = BigInt(matrices[0].rows);
  let total = 0n;
  for (let i = 1; i < matrices.length; i++) {
    const cols = BigInt(matrices[i].cols);
    total += rows * BigInt(matrices[i - 1].cols) * cols;
    // 结果矩阵尺寸 rows x cols
  }
  return total;
}

export function solve(chain: ValidatedChain): SolveResult & { dp: DpTable } {
  const dp = computeDp(chain);
  const plan = buildPlan(chain, dp);
  const optimal = dp.cost[0][chain.matrices.length - 1];
  const baseline = leftAssocCost(chain);
  return {
    dp,
    optimalCost: optimal.toString(),
    expression: planExpression(chain, dp),
    plan,
    steps: planSteps(plan),
    leftAssocCost: baseline.toString(),
    saving: (baseline - optimal).toString(),
  };
}

export interface ExplainEntry {
  k: number;
  leftId: string;
  rightId: string;
  leftCost: string;
  rightCost: string;
  mulCost: string;
  total: string;
  chosen: boolean;
  tied: boolean;
}

export function explainSplit(chain: ValidatedChain, dp: DpTable, i: number, j: number): {
  interval: { i: number; j: number };
  best: string;
  chosenK: number;
  tiedKs: number[];
  candidates: ExplainEntry[];
} {
  const n = chain.matrices.length;
  if (i < 0 || j < 0 || i >= n || j >= n || i > j) {
    throw new AppError("BAD_REQUEST", `区间 [${i}, ${j}] 超出范围 0..${n - 1}`);
  }
  if (i === j) {
    return {
      interval: { i, j },
      best: "0",
      chosenK: -1,
      tiedKs: [],
      candidates: [],
    };
  }
  const p = chain.dims;
  const candidates: ExplainEntry[] = [];
  for (let k = i; k < j; k++) {
    const mul = p[i] * p[k + 1] * p[j + 1];
    const total = dp.cost[i][k] + dp.cost[k + 1][j] + mul;
    candidates.push({
      k,
      leftId: `${chain.matrices[i].id}..${chain.matrices[k].id}`,
      rightId: `${chain.matrices[k + 1].id}..${chain.matrices[j].id}`,
      leftCost: dp.cost[i][k].toString(),
      rightCost: dp.cost[k + 1][j].toString(),
      mulCost: mul.toString(),
      total: total.toString(),
      chosen: k === dp.split[i][j],
      tied: dp.ties[i][j].includes(k),
    });
  }
  return {
    interval: { i, j },
    best: dp.cost[i][j].toString(),
    chosenK: dp.split[i][j],
    tiedKs: dp.ties[i][j],
    candidates,
  };
}

interface CandidateEval {
  rows: number;
  cols: number;
  cost: bigint;
  inorder: string[];
}

export function verifyCandidate(
  chain: ValidatedChain,
  optimalCost: bigint,
  candidate: unknown,
): VerifyReport {
  const errors: { code: string; message: string }[] = [];
  const byId = new Map(chain.matrices.map((m) => [m.id, m]));

  const evalNode = (node: unknown): CandidateEval | null => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) {
      errors.push({ code: "PLAN_MALFORMED", message: "计划节点必须是对象" });
      return null;
    }
    const rec = node as Record<string, unknown>;
    if ("leaf" in rec) {
      if (typeof rec.leaf !== "string") {
        errors.push({ code: "PLAN_MALFORMED", message: "leaf 必须是矩阵编号字符串" });
        return null;
      }
      const m = byId.get(rec.leaf);
      if (!m) {
        errors.push({ code: "PLAN_UNKNOWN_LEAF", message: `未知叶子编号 "${rec.leaf}"` });
        // 用占位尺寸继续遍历，便于同时报告重复/缺失等其他错误
        return { rows: 1, cols: 1, cost: 0n, inorder: [] };
      }
      return { rows: m.rows, cols: m.cols, cost: 0n, inorder: [m.id] };
    }
    if ("left" in rec && "right" in rec) {
      const l = evalNode(rec.left);
      const r = evalNode(rec.right);
      if (!l || !r) return null;
      if (l.cols !== r.rows) {
        errors.push({
          code: "PLAN_INCOMPATIBLE",
          message: `计划中存在不相容乘法：左结果 ${l.rows}x${l.cols} 与右结果 ${r.rows}x${r.cols} 无法相乘`,
        });
        // 不中断遍历，继续收集叶子层面的错误；该计划最终必为 invalid
      }
      return {
        rows: l.rows,
        cols: r.cols,
        cost: l.cost + r.cost + BigInt(l.rows) * BigInt(l.cols) * BigInt(r.cols),
        inorder: [...l.inorder, ...r.inorder],
      };
    }
    errors.push({ code: "PLAN_MALFORMED", message: "计划节点必须含 leaf 或 left+right" });
    return null;
  };

  const result = evalNode(candidate);
  let cost: bigint | null = null;
  if (result) {
    const counts = new Map<string, number>();
    for (const id of result.inorder) counts.set(id, (counts.get(id) ?? 0) + 1);
    for (const [id, c] of counts) {
      if (c > 1) {
        errors.push({ code: "PLAN_DUPLICATE_LEAF", message: `叶子 "${id}" 被使用 ${c} 次` });
      }
    }
    for (const m of chain.matrices) {
      if (!counts.has(m.id)) {
        errors.push({ code: "PLAN_MISSING_LEAF", message: `计划缺少矩阵 "${m.id}"` });
      }
    }
    const expected = chain.matrices.map((m) => m.id);
    if (
      errors.length === 0 &&
      (result.inorder.length !== expected.length ||
        result.inorder.some((id, idx) => id !== expected[idx]))
    ) {
      errors.push({
        code: "PLAN_ORDER_MISMATCH",
        message: `叶子中序顺序 [${result.inorder.join(", ")}] 与原链顺序 [${expected.join(", ")}] 不一致`,
      });
    }
    if (errors.length === 0) cost = result.cost;
  }

  const valid = errors.length === 0 && cost !== null;
  return {
    valid,
    errors,
    cost: valid && cost !== null ? cost.toString() : null,
    optimalCost: optimalCost.toString(),
    diff: valid && cost !== null ? (cost - optimalCost).toString() : null,
    isOptimal: valid && cost !== null ? cost === optimalCost : null,
  };
}
