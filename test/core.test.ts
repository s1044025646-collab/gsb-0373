import { test } from "node:test";
import assert from "node:assert/strict";
import {
  validateChain,
  solve,
  verifyCandidate,
  explainSplit,
  planTotalCost,
  MAX_DIMENSION,
  type ValidatedChain,
} from "../src/core.js";
import { AppError } from "../src/errors.js";
import type { CandidateNode, PlanNode } from "../src/types.js";

// ---- 独立枚举：不复用 DP 递推，枚举全部括号结构求最小代价与规范计划 ----

interface EnumResult {
  cost: bigint;
  tree: string;
}

function enumerateAll(chain: ValidatedChain): Map<string, EnumResult> {
  const dims = chain.dims;
  const ids = chain.matrices.map((m) => m.id);
  const memo = new Map<string, EnumResult[]>();
  const all = (i: number, j: number): EnumResult[] => {
    const key = `${i},${j}`;
    const hit = memo.get(key);
    if (hit) return hit;
    const out: EnumResult[] = [];
    if (i === j) {
      out.push({ cost: 0n, tree: ids[i] });
    } else {
      for (let k = i; k < j; k++) {
        for (const l of all(i, k)) {
          for (const r of all(k + 1, j)) {
            out.push({
              cost: l.cost + r.cost + dims[i] * dims[k + 1] * dims[j + 1],
              tree: `(${l.tree} x ${r.tree})`,
            });
          }
        }
      }
    }
    memo.set(key, out);
    return out;
  };
  const results = all(0, chain.matrices.length - 1);
  const best = results.reduce((a, b) => (a.cost <= b.cost ? a : b));
  // 规范计划：最小代价中按“最小 k 优先”递归选第一个
  const canonical = (i: number, j: number): string => {
    if (i === j) return ids[i];
    let bestK = -1;
    let bestC: bigint | null = null;
    for (let k = i; k < j; k++) {
      const sub = all(0, 0); // 触发 memo 填充
      void sub;
      const leftBest = minCost(all(i, k));
      const rightBest = minCost(all(k + 1, j));
      const c = leftBest + rightBest + dims[i] * dims[k + 1] * dims[j + 1];
      if (bestC === null || c < bestC) {
        bestC = c;
        bestK = k;
      }
    }
    return `(${canonical(i, bestK)} x ${canonical(bestK + 1, j)})`;
  };
  const minCost = (list: EnumResult[]): bigint =>
    list.reduce((m, e) => (e.cost < m ? e.cost : m), list[0].cost);
  const map = new Map<string, EnumResult>();
  map.set("best", best);
  map.set("canonical", { cost: best.cost, tree: canonical(0, chain.matrices.length - 1) });
  return map;
}

function chainFrom(dims: number[][]): ValidatedChain {
  return validateChain(dims.map((d, i) => ({ id: `M${i + 1}`, rows: d[0], cols: d[1] })));
}

// ---- 校验 ----

test("拒绝空链", () => {
  assert.throws(() => validateChain([]), (e) => e instanceof AppError && e.code === "EMPTY_CHAIN");
});

test("拒绝重复编号", () => {
  assert.throws(
    () => validateChain([{ id: "A", rows: 1, cols: 2 }, { id: "A", rows: 2, cols: 3 }]),
    (e) => (e as AppError).code === "DUPLICATE_MATRIX_ID",
  );
});

test("拒绝非法维度（0、负数、小数、超上限）", () => {
  for (const bad of [0, -3, 1.5, Number.NaN]) {
    assert.throws(
      () => validateChain([{ id: "A", rows: bad, cols: 2 }]),
      (e) => (e as AppError).code === "INVALID_DIMENSION",
    );
  }
  assert.throws(
    () => validateChain([{ id: "A", rows: MAX_DIMENSION + 1, cols: 2 }]),
    (e) => (e as AppError).code === "DIMENSION_LIMIT",
  );
});

test("不相容边界指出具体位置", () => {
  try {
    validateChain([
      { id: "A", rows: 2, cols: 3 },
      { id: "B", rows: 4, cols: 5 },
    ]);
    assert.fail("应当抛错");
  } catch (e) {
    assert.equal((e as AppError).code, "INCOMPATIBLE_BOUNDARY");
    assert.match((e as AppError).message, /A.*3.*B.*4/);
  }
});

test("拒绝超长链", () => {
  const many = Array.from({ length: 61 }, (_, i) => ({ id: `M${i}`, rows: 2, cols: 2 }));
  assert.throws(() => validateChain(many), (e) => (e as AppError).code === "CHAIN_TOO_LONG");
});

// ---- 基本求解 ----

test("单矩阵代价为零", () => {
  const r = solve(chainFrom([[5, 7]]));
  assert.equal(r.optimalCost, "0");
  assert.equal(r.expression, "M1");
  assert.deepEqual(r.steps, []);
});

test("两矩阵", () => {
  const r = solve(chainFrom([[2, 3], [3, 4]]));
  assert.equal(r.optimalCost, "24");
  assert.equal(r.expression, "(M1 x M2)");
  assert.equal(r.steps.length, 1);
});

test("经典示例 10x30,30x5,5x60", () => {
  const r = solve(chainFrom([[10, 30], [30, 5], [5, 60]]));
  assert.equal(r.optimalCost, "4500");
  assert.equal(r.leftAssocCost, "4500");
  assert.equal(r.expression, "((M1 x M2) x M3)");
});

test("右结合更贵的对照", () => {
  const chain = chainFrom([[10, 30], [30, 5], [5, 60]]);
  const report = verifyCandidate(chain, 4500n, {
    left: { leaf: "M1" },
    right: { left: { leaf: "M2" }, right: { leaf: "M3" } },
  } as CandidateNode);
  assert.equal(report.valid, true);
  assert.equal(report.cost, "27000");
  assert.equal(report.diff, "22500");
  assert.equal(report.isOptimal, false);
});

test("并列最优时选择最小 k（同尺寸矩阵）", () => {
  const chain = chainFrom([[10, 10], [10, 10], [10, 10], [10, 10]]);
  const r = solve(chain);
  assert.equal(r.optimalCost, "3000");
  assert.equal(r.expression, "(M1 x (M2 x (M3 x M4)))");
  const ex = explainSplit(chain, r.dp, 0, 3);
  assert.deepEqual(ex.tiedKs, [0, 1, 2]);
  assert.equal(ex.chosenK, 0);
});

test("计划节点代价之和等于报告值", () => {
  const r = solve(chainFrom([[10, 30], [30, 5], [5, 60], [60, 7], [7, 3]]));
  assert.equal(planTotalCost(r.plan).toString(), r.optimalCost);
  const stepSum = r.steps.reduce((a, s) => a + BigInt(s.cost), 0n);
  assert.equal(stepSum.toString(), r.optimalCost);
});

test("后序步骤把每个原矩阵恰好用一次且保持顺序", () => {
  const chain = chainFrom([[3, 4], [4, 5], [5, 6], [6, 7], [7, 8]]);
  const r = solve(chain);
  const leaves: string[] = [];
  const walk = (n: PlanNode): void => {
    if (n.kind === "leaf") leaves.push(n.id);
    else {
      walk(n.left);
      walk(n.right);
    }
  };
  walk(r.plan);
  assert.deepEqual(leaves, ["M1", "M2", "M3", "M4", "M5"]);
  assert.equal(r.steps.length, 4);
});

// ---- 超安全整数 ----

test("超过 Number.MAX_SAFE_INTEGER 的代价不丢失精度", () => {
  const d = MAX_DIMENSION; // 1e9
  const chain = chainFrom([[d, d], [d, d], [d, d]]);
  const r = solve(chain);
  const expected = 2n * BigInt(d) * BigInt(d) * BigInt(d);
  assert.ok(expected > BigInt(Number.MAX_SAFE_INTEGER));
  assert.equal(r.optimalCost, expected.toString());
  assert.equal(r.optimalCost, "2000000000000000000000000000");
});

// ---- 候选计划核验 ----

test("候选计划：未知叶子、重复叶子、缺矩阵、顺序篡改、维度不兼容", () => {
  const chain = chainFrom([[2, 3], [3, 4], [4, 5]]);
  const opt = BigInt(solve(chain).optimalCost);

  const unknown = verifyCandidate(chain, opt, { leaf: "ZZ" });
  assert.equal(unknown.valid, false);
  assert.ok(unknown.errors.some((e) => e.code === "PLAN_UNKNOWN_LEAF"));

  const dup = verifyCandidate(chain, opt, {
    left: { leaf: "M1" },
    right: { left: { leaf: "M1" }, right: { leaf: "M3" } },
  });
  assert.ok(dup.errors.some((e) => e.code === "PLAN_DUPLICATE_LEAF"));

  const missing = verifyCandidate(chain, opt, { left: { leaf: "M1" }, right: { leaf: "M2" } });
  assert.ok(missing.errors.some((e) => e.code === "PLAN_MISSING_LEAF"));

  // 非方阵链中篡改顺序会先触发维度不兼容
  const reorderedIncompat = verifyCandidate(chain, opt, {
    left: { leaf: "M2" },
    right: { left: { leaf: "M1" }, right: { leaf: "M3" } },
  });
  assert.ok(reorderedIncompat.errors.some((e) => e.code === "PLAN_INCOMPATIBLE"));

  // 方阵链中篡改顺序可被维度兼容掩盖，必须显式报顺序错误
  const squareChain = chainFrom([[5, 5], [5, 5], [5, 5]]);
  const squareOpt = BigInt(solve(squareChain).optimalCost);
  const reordered = verifyCandidate(squareChain, squareOpt, {
    left: { leaf: "M2" },
    right: { left: { leaf: "M1" }, right: { leaf: "M3" } },
  });
  assert.ok(reordered.errors.some((e) => e.code === "PLAN_ORDER_MISMATCH"));

  const malformed = verifyCandidate(chain, opt, { foo: 1 });
  assert.ok(malformed.errors.some((e) => e.code === "PLAN_MALFORMED"));
});

// ---- 独立枚举核对（<=6 个矩阵） ----

test("枚举全部括号结构核对最优值与规范计划（多条 <=6 链）", () => {
  const cases: number[][][] = [
    [[10, 30], [30, 5], [5, 60]],
    [[5, 4], [4, 6], [6, 2], [2, 7]],
    [[30, 35], [35, 15], [15, 5], [5, 10], [10, 20], [20, 25]],
    [[7, 7], [7, 7], [7, 7], [7, 7], [7, 7]],
    [[2, 9], [9, 1], [1, 8], [8, 8], [8, 3], [3, 4]],
    [[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7]],
  ];
  for (const dims of cases) {
    const chain = chainFrom(dims);
    const r = solve(chain);
    const enumResult = enumerateAll(chain);
    const best = enumResult.get("best") as EnumResult;
    const canonical = enumResult.get("canonical") as EnumResult;
    assert.equal(r.optimalCost, best.cost.toString(), `最优值不一致: ${JSON.stringify(dims)}`);
    assert.equal(r.expression, canonical.tree, `规范计划不一致: ${JSON.stringify(dims)}`);
  }
});
