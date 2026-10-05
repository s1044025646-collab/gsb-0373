export type ErrorCode =
  | 'EMPTY_CHAIN'
  | 'CHAIN_TOO_LONG'
  | 'DUPLICATE_MATRIX_ID'
  | 'INVALID_DIMENSION'
  | 'DIMENSION_LIMIT'
  | 'INCOMPATIBLE_BOUNDARY'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'PLAN_UNKNOWN_LEAF'
  | 'PLAN_DUPLICATE_LEAF'
  | 'PLAN_MISSING_LEAF'
  | 'PLAN_ORDER_MISMATCH'
  | 'PLAN_INCOMPATIBLE'
  | 'PLAN_MALFORMED';

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}
