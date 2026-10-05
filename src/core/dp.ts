import { PlannerError, LIMITS } from "./errors.js";
import type {
  CellDetail,
  ExecutionStep,
  MatrixInput,
  MatrixRecord,
  OptimalPlan,
  PlanNode,
} from "./types.js";

/**
 * 校验并规范化输入尺寸链。
 * - 空链拒绝；长度上限 60；行列必须为正整数且不超过公开上限；
 * - 编号唯一；相邻矩阵列数必须等于下一行数，否则指出具体边界。
 */
export function validateChain(input: MatrixInput[]): MatrixRecord[] {
  if (!Array.isArray(input) || input.length === 0) {
    throw new PlannerError("EMPTY_CHAIN", "矩阵链不能为空：至少需要 1 个矩阵");
  }
  if (input.length > LIMITS.MAX_MATRICES) {
    throw new PlannerError(
      "CHAIN_TOO_LONG",
      `链长度 ${input.length} 超过上限 ${LIMITS.MAX_MATRICES}`,
      { length: input.length, max: LIMITS.MAX_MATRICES },
    );
  }

  const seen = new Set<string>();
  const records: MatrixRecord[] = [];
  for (let i = 0; i < input.length; i++) {
    const raw = input[i];
    if (!raw || typeof raw.id !== "string" || raw.id.trim() === "") {
      throw new PlannerError("BAD_REQUEST", `第 ${i} 个矩阵缺少有效编号 id`);
    }
    if (seen.has(raw.id)) {
      throw new PlannerError("DUPLICATE_MATRIX_ID", `矩阵编号重复：${raw.id}`, {
        id: raw.id,
      });
    }
    seen.add(raw.id);

    const rows = toBigIntDim(raw.rows, `${raw.id}.rows`);
    const cols = toBigIntDim(raw.cols, `${raw.id}.cols`);
    records.push({ id: raw.id, rows, cols, index: i });
  }

  for (let i = 0; i + 1 < records.length; i++) {
    const a = records[i]!;
    const b = records[i + 1]!;
    if (a.cols !== b.rows) {
      throw new PlannerError(
        "INCOMPATIBLE_DIMS",
        `边界 ${i}→${i + 1}（${a.id} 与 ${b.id}）维度不兼容：` +
          `${a.id} 为 ${a.rows}×${a.cols}，${b.id} 为 ${b.rows}×${b.cols}，` +
          `要求前者列数 ${a.cols} 等于后者行数 ${b.rows}（不会自动转置）`,
        { boundary: i, left: a.id, right: b.id, expected: a.cols, got: b.rows },
      );
    }
  }
  return records;
}

function toBigIntDim(value: unknown, label: string): bigint {
  let n: bigint;
  if (typeof value === "bigint") {
    n = value;
  } else if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new PlannerError("INVALID_DIMENSION", `${label} 必须是正整数，收到 ${value}`);
    }
    n = BigInt(value);
  } else if (typeof value === "string" && /^[0-9]+$/.test(value.trim())) {
    n = BigInt(value.trim());
  } else {
    throw new PlannerError("INVALID_DIMENSION", `${label} 必须是正整数（数字或十进制字符串）`);
  }
  if (n <= 0n) {
    throw new PlannerError("INVALID_DIMENSION", `${label} 必须为正整数，收到 ${n.toString()}`);
  }
  if (n > LIMITS.MAX_DIMENSION) {
    throw new PlannerError(
      "INVALID_DIMENSION",
      `${label}=${n.toString()} 超过公开上限 ${LIMITS.MAX_DIMENSION}`,
    );
  }
  return n;
}

/**
 * 区间动态规划（自行实现，无第三方优化库）。
 * dp[i][j] = min over k in [i,j-1] dp[i][k] + dp[k+1][j] + p[i]*p[k+1]*p[j+1]
 * k 从小到大扫描且仅在严格更小时更新，因此同代价自动保留最小 k。
 */
export function solveOptimal(input: MatrixInput[]): OptimalPlan {
  const matrices = validateChain(input);
  const n = matrices.length;
  const dims: bigint[] = matrices.map((m) => m.rows);
  dims.push(matrices[n - 1]!.cols);

  const dp: bigint[][] = Array.from({ length: n }, () => new Array<bigint>(n).fill(0n));
  const split: (number | null)[][] = Array.from({ length: n }, () =>
    new Array<number | null>(n).fill(null),
  );
  const table: CellDetail[][] = Array.from({ length: n }, () =>
    new Array<CellDetail>(n),
  );

  for (let i = 0; i < n; i++) {
    table[i]![i] = {
      from: i,
      to: i,
      resultRows: matrices[i]!.rows,
      resultCols: matrices[i]!.cols,
      minCost: 0n,
      bestSplit: null,
      candidates: [],
      tiedSplits: [],
    };
  }

  for (let len = 2; len <= n; len++) {
    for (let i = 0; i + len - 1 < n; i++) {
      const j = i + len - 1;
      const candidates: CellDetail["candidates"] = [];
      let best: bigint | null = null;
      let bestK = i;

      for (let k = i; k < j; k++) {
        const leftCost = dp[i]![k]!;
        const rightCost = dp[k + 1]![j]!;
        const combine = dims[i]! * dims[k + 1]! * dims[j + 1]!;
        const total = leftCost + rightCost + combine;
        candidates.push({
          split: k,
          leftCost,
          rightCost,
          combineCost: combine,
          total,
          optimal: false,
        });
        if (best === null || total < best) {
          best = total;
          bestK = k;
        }
      }

      const tiedSplits = candidates.filter((c) => c.total === best).map((c) => c.split);
      for (const c of candidates) c.optimal = c.total === best;

      dp[i]![j] = best!;
      split[i]![j] = bestK;
      table[i]![j] = {
        from: i,
        to: j,
        resultRows: dims[i]!,
        resultCols: dims[j + 1]!,
        minCost: best!,
        bestSplit: bestK,
        candidates,
        tiedSplits,
      };
    }
  }

  const tree = buildTree(0, n - 1);
  const steps = postOrder(tree);

  function buildTree(i: number, j: number): PlanNode {
    if (i === j) {
      const m = matrices[i]!;
      return {
        id: m.id,
        kind: "leaf",
        rows: m.rows,
        cols: m.cols,
        multiplyCost: 0n,
        totalCost: 0n,
        from: i,
        to: j,
        expression: m.id,
      };
    }
    const k = split[i]![j]!;
    const left = buildTree(i, k);
    const right = buildTree(k + 1, j);
    const multiplyCost = dims[i]! * dims[k + 1]! * dims[j + 1]!;
    return {
      id: `R${i}-${j}`,
      kind: "combine",
      split: k,
      left,
      right,
      rows: dims[i]!,
      cols: dims[j + 1]!,
      multiplyCost,
      totalCost: dp[i]![j]!,
      from: i,
      to: j,
      expression: `(${left.expression} ${right.expression})`,
    };
  }

  return {
    tree,
    expression: tree.expression,
    steps,
    totalCost: dp[0]![n - 1]!,
    table,
    matrices,
    dims,
  };
}

/** 后序遍历生成可执行步骤：先叶子，再乘法；累计代价可直接核验。 */
export function postOrder(tree: PlanNode): ExecutionStep[] {
  const steps: ExecutionStep[] = [];
  let cumulative = 0n;

  const walk = (node: PlanNode): void => {
    if (node.kind === "leaf") {
      steps.push({
        step: steps.length + 1,
        kind: "leaf",
        resultId: node.id,
        rows: node.rows,
        cols: node.cols,
        multiplyCost: 0n,
        cumulativeCost: cumulative,
      });
      return;
    }
    walk(node.left!);
    walk(node.right!);
    cumulative += node.multiplyCost;
    steps.push({
      step: steps.length + 1,
      kind: "multiply",
      leftId: node.left!.id,
      rightId: node.right!.id,
      resultId: node.id,
      rows: node.rows,
      cols: node.cols,
      multiplyCost: node.multiplyCost,
      cumulativeCost: cumulative,
    });
  };
  walk(tree);
  return steps;
}

/** 始终从左到右结合的基准代价与表达式（证明贪心不等于全局最优）。 */
export function leftAssociative(input: MatrixInput[]): { cost: bigint; expression: string } {
  const matrices = validateChain(input);
  const dims: bigint[] = matrices.map((m) => m.rows);
  dims.push(matrices[matrices.length - 1]!.cols);
  let cost = 0n;
  // (((M0 M1) M2) M3) ...：第 t 次合并结果尺寸 p0 x p[t+1]，与 p[t+1] x p[t+2] 相乘
  for (let t = 1; t < matrices.length; t++) {
    cost += dims[0]! * dims[t]! * dims[t + 1]!;
  }
  const expression = matrices.slice(1).reduce((acc, m) => `(${acc} ${m.id})`, matrices[0]!.id);
  return { cost, expression };
}

/**
 * 独立枚举所有括号结构（Catalan 递归），不使用 DP 表，用于小规模交叉验证。
 * 同时返回取得最小代价时“最小分割点递归”的规范表达式，应与 DP 一致。
 */
export function enumerateAllPlans(input: MatrixInput[]): {
  count: number;
  minCost: bigint;
  canonicalExpression: string;
  costs: bigint[];
} {
  const matrices = validateChain(input);
  const dims: bigint[] = matrices.map((m) => m.rows);
  dims.push(matrices[matrices.length - 1]!.cols);
  const costs: bigint[] = [];
  let minCost: bigint | null = null;
  let canonicalExpression = "";

  const rec = (
    i: number,
    j: number,
  ): { cost: bigint; expr: string; rows: bigint; cols: bigint }[] => {
    if (i === j) {
      return [{ cost: 0n, expr: matrices[i]!.id, rows: dims[i]!, cols: dims[i + 1]! }];
    }
    const out: ReturnType<typeof rec> = [];
    for (let k = i; k < j; k++) {
      for (const l of rec(i, k)) {
        for (const r of rec(k + 1, j)) {
          const combine = l.rows * l.cols * r.cols;
          out.push({
            cost: l.cost + r.cost + combine,
            expr: `(${l.expr} ${r.expr})`,
            rows: l.rows,
            cols: r.cols,
          });
        }
      }
    }
    return out;
  };

  const all = rec(0, matrices.length - 1);
  // 与 DP 相同的规范规则：按“最小 k 优先”的递归顺序取第一个最小值。
  // rec 以 k 升序展开，all 的顺序天然满足该 tie-break，故 find 即可。
  for (const p of all) {
    costs.push(p.cost);
    if (minCost === null || p.cost < minCost) {
      minCost = p.cost;
      canonicalExpression = p.expr;
    }
  }
  return { count: all.length, minCost: minCost!, canonicalExpression, costs };
}
