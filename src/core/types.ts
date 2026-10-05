/** 输入的单个矩阵：唯一编号 + 行数列数（均为正整数） */
export interface MatrixInput {
  id: string;
  rows: bigint;
  cols: bigint;
}

/** 持久化用的矩阵（带链内下标，从 0 开始） */
export interface MatrixRecord extends MatrixInput {
  index: number;
}

/** 二叉计划树节点 */
export interface PlanNode {
  /** 叶子为矩阵编号，内部节点为自动生成的组合标签 R<index>:<from>-<to> */
  id: string;
  kind: "leaf" | "combine";
  /** 叶子即原矩阵；内部节点为分割点 k（左链以 k 结尾，k 为左子链最后一个矩阵下标） */
  split?: number;
  left?: PlanNode;
  right?: PlanNode;
  /** 该节点结果尺寸 */
  rows: bigint;
  cols: bigint;
  /** 该节点本身引入的标量乘法次数（叶子为 0） */
  multiplyCost: bigint;
  /** 该子链总代价 */
  totalCost: bigint;
  /** 覆盖的原矩阵下标区间 [from, to] */
  from: number;
  to: number;
  /** 该子树的完整括号表达式（叶子为编号本身） */
  expression: string;
}

/** 后序执行步骤 */
export interface ExecutionStep {
  step: number;
  kind: "leaf" | "multiply";
  /** multiply 时参与相乘的两个先前结果 id */
  leftId?: string;
  rightId?: string;
  resultId: string;
  rows: bigint;
  cols: bigint;
  multiplyCost: bigint;
  /** 本次相乘后累计代价 */
  cumulativeCost: bigint;
}

/** 单个区间的 DP 明细，用于解释分割选择 */
export interface CellDetail {
  from: number;
  to: number;
  resultRows: bigint;
  resultCols: bigint;
  minCost: bigint;
  bestSplit: number | null;
  /** 该区间尝试过的所有分割点（按 k 升序） */
  candidates: SplitCandidate[];
  /** 达到同样最小代价的并列分割点（按 k 升序，最小者为 bestSplit） */
  tiedSplits: number[];
}

export interface SplitCandidate {
  split: number;
  leftCost: bigint;
  rightCost: bigint;
  combineCost: bigint;
  total: bigint;
  optimal: boolean;
}

export interface OptimalPlan {
  tree: PlanNode;
  expression: string;
  steps: ExecutionStep[];
  totalCost: bigint;
  table: CellDetail[][];
  matrices: MatrixRecord[];
  /** 尺寸数组 p[0..n]，矩阵 i 尺寸 p[i] x p[i+1] */
  dims: bigint[];
}

export interface CandidateVerifyResult {
  valid: boolean;
  errorCode?: string;
  message?: string;
  /** 计划用到的叶子编号（按下标顺序），供核对 */
  leafOrder?: string[];
  totalCost?: bigint;
  expression?: string;
  steps?: ExecutionStep[];
  optimalCost?: bigint;
  /** totalCost - optimalCost，合法时非负 */
  costGap?: bigint;
  optimal: boolean;
}

/** 全部 API/持久化对象的十进制字符串序列化形态 */
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };
