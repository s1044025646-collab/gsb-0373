import { PlannerError } from "./errors.js";
import { postOrder } from "./dp.js";
import type {
  CandidateVerifyResult,
  ExecutionStep,
  MatrixRecord,
  PlanNode,
} from "./types.js";

/**
 * 用户候选计划（JSON）：
 *   { "type": "leaf", "id": "A" }
 *   { "type": "mul", "left": <Plan>, "right": <Plan> }
 */
export type CandidatePlanDTO =
  | { type: "leaf"; id: string }
  | { type: "mul"; left: CandidatePlanDTO; right: CandidatePlanDTO };

interface Built {
  node: PlanNode;
  leaves: MatrixRecord[];
}

/**
 * 独立核验：完全按用户给的二叉组合重新构建并计算，
 * 不读取最优 DP 的结果做假设；最后才与 optimalCost 对比。
 */
export function verifyCandidate(
  candidate: unknown,
  matrices: MatrixRecord[],
  optimalCost: bigint,
): CandidateVerifyResult {
  const fail = (
    code: CandidateVerifyResult["errorCode"],
    message: string,
  ): CandidateVerifyResult => ({
    valid: false,
    optimal: false,
    errorCode: code,
    message,
    optimalCost,
  });

  if (candidate === null || typeof candidate !== "object") {
    return fail("BAD_CANDIDATE", "候选计划必须是对象：{type:'leaf',id} 或 {type:'mul',left,right}");
  }
  const dto = candidate as Partial<CandidatePlanDTO>;
  if (dto.type !== "leaf" && dto.type !== "mul") {
    return fail("BAD_CANDIDATE", "节点 type 必须为 leaf 或 mul");
  }

  const byId = new Map(matrices.map((m) => [m.id, m]));
  const used = new Set<string>();
  let counter = 0;

  const build = (node: unknown, context: string): Built => {
    if (node === null || typeof node !== "object") {
      throw new PlannerError("BAD_CANDIDATE", `${context} 不是有效节点`);
    }
    const n = node as Partial<CandidatePlanDTO>;
    if (n.type === "leaf") {
      if (typeof n.id !== "string" || n.id === "") {
        throw new PlannerError("BAD_CANDIDATE", `${context} 叶子缺少 id`);
      }
      if (!byId.has(n.id)) {
        throw new PlannerError("BAD_CANDIDATE", `未知叶子编号：${n.id}`);
      }
      if (used.has(n.id)) {
        throw new PlannerError("BAD_CANDIDATE", `叶子 ${n.id} 在计划中被重复使用`);
      }
      used.add(n.id);
      const m = byId.get(n.id)!;
      return {
        node: {
          id: m.id,
          kind: "leaf",
          rows: m.rows,
          cols: m.cols,
          multiplyCost: 0n,
          totalCost: 0n,
          from: m.index,
          to: m.index,
          expression: m.id,
        },
        leaves: [m],
      };
    }
    if (n.type === "mul") {
      if (!n.left || !n.right) {
        throw new PlannerError("BAD_CANDIDATE", `${context} mul 节点缺少 left 或 right`);
      }
      const left = build(n.left, `${context}.left`);
      const right = build(n.right, `${context}.right`);
      // 维度兼容：左结果列数必须等于右结果行数（不转置）
      if (left.node.cols !== right.node.rows) {
        throw new PlannerError(
          "BAD_CANDIDATE",
          `维度不兼容：(${left.node.expression}) 结果 ${left.node.rows}×${left.node.cols} ` +
            `无法与 (${right.node.expression}) 结果 ${right.node.rows}×${right.node.cols} 相乘`,
        );
      }
      // 顺序篡改：右子树的最小下标必须大于左子树最大下标（每个子树是连续区间）
      if (left.leaves[left.leaves.length - 1]!.index >= right.leaves[0]!.index) {
        throw new PlannerError(
          "BAD_CANDIDATE",
          `矩阵顺序错误：组合 (${left.node.expression}) * (${right.node.expression}) ` +
            `中 ${right.leaves[0]!.id} 出现在 ${left.leaves[left.leaves.length - 1]!.id} 之前，` +
            `不允许改变矩阵固定顺序`,
        );
      }
      const multiplyCost = left.node.rows * left.node.cols * right.node.cols;
      counter += 1;
      const combined: PlanNode = {
        id: `C${counter}`,
        kind: "combine",
        left: left.node,
        right: right.node,
        rows: left.node.rows,
        cols: right.node.cols,
        multiplyCost,
        totalCost: left.node.totalCost + right.node.totalCost + multiplyCost,
        from: left.leaves[0]!.index,
        to: right.leaves[right.leaves.length - 1]!.index,
        expression: `(${left.node.expression} ${right.node.expression})`,
      };
      return { node: combined, leaves: [...left.leaves, ...right.leaves] };
    }
    throw new PlannerError("BAD_CANDIDATE", `${context} 节点 type 非法`);
  };

  let built: Built;
  try {
    built = build(dto, "root");
  } catch (e) {
    if (e instanceof PlannerError) {
      return fail(e.code, e.message);
    }
    throw e;
  }

  const leafOrder = built.leaves.map((m) => m.id);

  // 缺矩阵 / 多矩阵：数量与集合必须完全一致
  if (built.leaves.length !== matrices.length) {
    const missing = matrices.filter((m) => !used.has(m.id)).map((m) => m.id);
    return fail(
      "BAD_CANDIDATE",
      `计划包含 ${built.leaves.length} 个叶子，链中有 ${matrices.length} 个矩阵；` +
        (missing.length > 0 ? `缺少矩阵：${missing.join(", ")}` : "叶子数量不符"),
    );
  }
  const expectedOrder = matrices.map((m) => m.id);
  for (let i = 0; i < expectedOrder.length; i++) {
    if (leafOrder[i] !== expectedOrder[i]) {
      return fail(
        "BAD_CANDIDATE",
        `叶子顺序错误：位置 ${i} 应为 ${expectedOrder[i]}，实际为 ${leafOrder[i]}`,
      );
    }
  }

  const steps: ExecutionStep[] = postOrder(built.node);
  const totalCost = built.node.totalCost;
  const costGap = totalCost - optimalCost;

  return {
    valid: true,
    optimal: costGap === 0n,
    leafOrder,
    totalCost,
    expression: built.node.expression,
    steps,
    optimalCost,
    costGap,
    message:
      costGap === 0n
        ? "候选计划合法且达到最优代价"
        : `候选计划合法但非最优，比最优值多 ${costGap.toString()} 次标量乘法`,
  };
}
