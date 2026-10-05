/**
 * 统一错误码。所有面向 API/CLI 的校验失败都抛出 PlannerError，
 * 调用方根据 code 返回 4xx 或打印中文错误。
 */
export type ErrorCode =
  | "EMPTY_CHAIN"
  | "CHAIN_TOO_LONG"
  | "INVALID_DIMENSION"
  | "DUPLICATE_MATRIX_ID"
  | "INCOMPATIBLE_DIMS"
  | "NOT_FOUND"
  | "BAD_CANDIDATE"
  | "BAD_REQUEST"
  | "CONFLICT";

export class PlannerError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = "PlannerError";
    this.code = code;
    this.details = details;
  }
}

/** 全局公开限制 */
export const LIMITS = {
  /** 链中矩阵数量上限 */
  MAX_MATRICES: 60,
  /** 单个维度（行数/列数）上限 */
  MAX_DIMENSION: 1_000_000n,
  /** 解释明细默认返回条数 */
  DEFAULT_DETAIL_LIMIT: 50,
  /** 解释明细最大返回条数 */
  MAX_DETAIL_LIMIT: 500,
} as const;
