/**
 * Money helpers.
 *
 * Every amount in this system is an integer number of minor units (cents).
 * No floating point arithmetic touches a monetary value anywhere — the one
 * place a float appears is when parsing a decimal string from a request or a
 * seed file, and that parse is immediately rounded to an integer.
 */

/** Raised when a value cannot be represented exactly as integer cents. */
export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/**
 * Parse a decimal string or number into integer cents.
 *
 * Rejects anything with more precision than the currency can represent
 * rather than silently rounding it, because a silently-rounded amount is a
 * ledger that does not balance against its source.
 */
export function parseAmountToCents(value: string | number): number {
  const raw = typeof value === 'number' ? String(value) : value.trim();
  if (raw === '') throw new MoneyError('amount is empty');
  if (!/^-?\d+(\.\d+)?$/.test(raw)) {
    throw new MoneyError(`amount is not a valid decimal: ${raw}`);
  }
  const negative = raw.startsWith('-');
  const unsigned = negative ? raw.slice(1) : raw;
  const [whole, frac = ''] = unsigned.split('.');
  if (frac.length > 2) {
    throw new MoneyError(
      `amount has more precision than cents can represent: ${raw}`,
    );
  }
  const cents = Number(whole) * 100 + Number((frac + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents)) {
    throw new MoneyError(`amount is out of safe range: ${raw}`);
  }
  return negative ? -cents : cents;
}

/** Render integer cents as a fixed 2dp decimal string. */
export function formatCents(cents: number): string {
  if (!Number.isInteger(cents)) {
    throw new MoneyError(`not an integer number of cents: ${cents}`);
  }
  const negative = cents < 0;
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

/** Format for display with a currency symbol prefix. */
export function formatMoney(cents: number, currency = 'USD'): string {
  const symbol = currency === 'USD' ? '$' : `${currency} `;
  return `${symbol}${formatCents(cents)}`;
}

/** Assert a non-negative integer cent amount. */
export function assertPositiveCents(cents: number, label = 'amount'): void {
  if (!Number.isInteger(cents)) {
    throw new MoneyError(`${label} must be an integer number of cents`);
  }
  if (cents <= 0) {
    throw new MoneyError(`${label} must be positive`);
  }
}
