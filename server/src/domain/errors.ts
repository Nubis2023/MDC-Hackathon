/** Typed errors with stable codes, so the API and agent tools can map them. */

export type LedgerErrorCode =
  | 'not_found'
  | 'forbidden'
  | 'validation'
  | 'conflict'
  | 'unbalanced'
  | 'immutable'
  | 'already_posted'
  | 'not_approved'
  | 'self_approval'
  | 'stale_state'
  | 'insufficient_funds'
  | 'duplicate';

export class LedgerError extends Error {
  readonly code: LedgerErrorCode;
  readonly httpStatus: number;
  readonly detail?: unknown;

  constructor(
    code: LedgerErrorCode,
    message: string,
    options: { httpStatus?: number; detail?: unknown } = {},
  ) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.httpStatus = options.httpStatus ?? defaultStatusFor(code);
    this.detail = options.detail;
  }
}

function defaultStatusFor(code: LedgerErrorCode): number {
  switch (code) {
    case 'not_found':
      return 404;
    case 'forbidden':
      return 403;
    case 'validation':
    case 'unbalanced':
      return 400;
    case 'self_approval':
    case 'not_approved':
      return 403;
    case 'conflict':
    case 'already_posted':
    case 'duplicate':
    case 'stale_state':
    case 'immutable':
    case 'insufficient_funds':
      return 409;
    default:
      return 500;
  }
}

export function isLedgerError(err: unknown): err is LedgerError {
  return err instanceof LedgerError;
}
