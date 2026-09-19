/**
 * Account mapping resolution and the balanced-entry builder.
 *
 * Every operation in this service produces a list of PostingSpec values
 * (mapping key + side + amount). This module turns those specs into concrete
 * journal lines by looking up each seller's account_mappings, then asserts
 * the result balances before it can be posted.
 *
 * The reason operations never name an account code directly: the requirement
 * is that entries use *configured* account mappings. If a seller remaps
 * their fee expense account, no service code changes.
 */

import type { Db } from '../db';
import { LedgerError } from './errors';
import type { PostingSpec, ProposedLine } from './types';

export interface ResolvedAccount {
  account_id: string;
  account_code: string;
  account_name: string;
  account_type: string;
}

/**
 * Look up the account configured for a (mapping_key, side) pair.
 * Throws rather than falling back to a default: an unmapped event is a
 * configuration error, and posting it against a guessed account would be
 * worse than refusing.
 */
export function resolveAccount(
  db: Db,
  sellerId: string,
  mappingKey: string,
  side: 'debit' | 'credit',
): ResolvedAccount {
  const row = db
    .prepare(
      `SELECT a.id AS account_id, a.code AS account_code, a.name AS account_name,
              a.type AS account_type
         FROM account_mappings m
         JOIN gl_accounts a ON a.seller_id = m.seller_id AND a.id = m.account_id
        WHERE m.seller_id = ? AND m.mapping_key = ? AND m.side = ?`,
    )
    .get(sellerId, mappingKey, side) as ResolvedAccount | undefined;

  if (!row) {
    throw new LedgerError(
      'validation',
      `no account mapping configured for seller ${sellerId}, ` +
        `mapping_key '${mappingKey}', side '${side}'`,
    );
  }
  return row;
}

export interface BuiltEntry {
  lines: ProposedLine[];
  total_debit_cents: number;
  total_credit_cents: number;
  balanced: boolean;
}

/**
 * Turn posting specs into display-ready lines and check the entry balances.
 *
 * `balanced` is returned rather than only thrown so the preview path can show
 * an unbalanced proposal to a human and explain why it was rejected, while
 * the post path treats unbalanced as fatal.
 */
export function buildLines(
  db: Db,
  sellerId: string,
  specs: PostingSpec[],
): BuiltEntry {
  if (specs.length === 0) {
    throw new LedgerError('validation', 'a journal entry needs at least one line');
  }

  const lines: ProposedLine[] = specs.map((spec) => {
    if (!Number.isInteger(spec.amount_cents) || spec.amount_cents === 0) {
      throw new LedgerError(
        'validation',
        `posting spec for '${spec.mapping_key}' must have a non-zero integer amount`,
      );
    }
    if (spec.amount_cents < 0) {
      throw new LedgerError(
        'validation',
        `posting spec for '${spec.mapping_key}' must be a positive amount; ` +
          `use the opposite side to reverse direction`,
      );
    }
    const account = resolveAccount(db, sellerId, spec.mapping_key, spec.side);
    const line: ProposedLine = {
      account_id: account.account_id,
      account_code: account.account_code,
      account_name: account.account_name,
      amount_cents: spec.amount_cents,
      side: spec.side,
    };
    if (spec.memo !== undefined) line.memo = spec.memo;
    return line;
  });

  const totalDebit = lines
    .filter((l) => l.side === 'debit')
    .reduce((acc, l) => acc + l.amount_cents, 0);
  const totalCredit = lines
    .filter((l) => l.side === 'credit')
    .reduce((acc, l) => acc + l.amount_cents, 0);

  return {
    lines,
    total_debit_cents: totalDebit,
    total_credit_cents: totalCredit,
    balanced: totalDebit === totalCredit && totalDebit > 0,
  };
}

/** Signed line amount: debit positive, credit negative. Sums to zero when balanced. */
export function signedAmount(line: {
  side: 'debit' | 'credit';
  amount_cents: number;
}): number {
  return line.side === 'debit' ? line.amount_cents : -line.amount_cents;
}

/** Negate a built entry's lines — the basis of every reversal. */
export function negateLines(lines: ProposedLine[]): ProposedLine[] {
  return lines.map((line) => ({
    ...line,
    side: line.side === 'debit' ? 'credit' : 'debit',
  }));
}

/** Assert balance, throwing the error the post path uses. */
export function assertBalanced(built: BuiltEntry): void {
  if (!built.balanced) {
    throw new LedgerError(
      'unbalanced',
      `refusing to post an unbalanced entry: debits ${built.total_debit_cents} ` +
        `vs credits ${built.total_credit_cents}`,
    );
  }
}
