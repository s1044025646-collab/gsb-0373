export interface MatrixSpec {
  id: string;
  rows: number;
  cols: number;
}

export interface PlanLeaf {
  kind: "leaf";
  id: string;
  rows: number;
  cols: number;
}

export interface PlanMul {
  kind: "mul";
  left: PlanNode;
  right: PlanNode;
  rows: number;
  cols: number;
  cost: string; // BigInt 十进制字符串
}

export type PlanNode = PlanLeaf | PlanMul;

export interface Step {
  step: number;
  left: string;
  right: string;
  resultRows: number;
  resultCols: number;
  cost: string;
}

export interface SolveResult {
  optimalCost: string;
  expression: string;
  plan: PlanNode;
  steps: Step[];
  leftAssocCost: string;
  saving: string;
}

export type CandidateNode =
  | { leaf: string }
  | { left: CandidateNode; right: CandidateNode };

export interface VerifyReport {
  valid: boolean;
  errors: { code: string; message: string }[];
  cost: string | null;
  optimalCost: string;
  diff: string | null;
  isOptimal: boolean | null;
}
