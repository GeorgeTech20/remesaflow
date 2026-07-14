/**
 * F-EXEC — remittance audit log + daily-cap ledger.
 *
 * Two jobs, one file (`logs/remits.jsonl`, one JSON object per line):
 *
 * 1. AUDIT (for the judges): every executed remittance is appended with its
 *    txHash, corridor, rate and the attribution tag actually used. The
 *    recipient is stored HASHED (sha256, first 12 hex) — the plaintext address
 *    is already public on-chain in the tx itself, so the log never needs it.
 *
 * 2. DAILY CAP: the in-memory counter is rebuilt from this file at boot, so a
 *    restart cannot reset the agent's spending limit. Entries whose tx reverted
 *    (status "failed") moved no value and are not counted.
 *
 * Concurrency: reserve() checks and books the amount ATOMICALLY (single-threaded
 * event loop, no await inside), so two in-flight requests can never both squeeze
 * under the cap. The caller must commit() or release() the reservation.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// backend/src or backend/dist -> one level up = backend/logs
const DEFAULT_REMIT_LOG_FILE = path.resolve(HERE, '../logs/remits.jsonl');

export type RemitStatus = 'success' | 'pending' | 'failed';

export interface RemitLogEntry {
  timestamp: string;
  /** USD amount sent. */
  amount: number;
  /** e.g. "USD-KES". */
  corridor: string;
  /** sha256(recipient)[0..12] — never the raw address. */
  recipientHash: string;
  /** The value-carrying tx (the Mento swap). null only if it was never broadcast. */
  txHash: string | null;
  /** The (optional) ERC-20 approve that preceded it. Moves no value. */
  approvalTxHash: string | null;
  /** USD -> local rate actually executed at. */
  rate: number;
  /** Local-currency amount delivered to the recipient. */
  received: number;
  /** ERC-8021 attribution code carried by the tx (null on an untagged testnet run). */
  tag: string | null;
  network: string;
  status: RemitStatus;
}

export interface RemitLog {
  /** Atomically books `amount` against today's cap. False => cap would be exceeded. */
  reserve(amount: number): boolean;
  /**
   * Appends the audit entry and books it against today's spend, keyed by
   * txHash (so the pending->final write is a correction, not a double-count).
   * Does NOT touch the reservation: the caller releases that exactly once.
   */
  commit(entry: RemitLogEntry): void;
  /**
   * Gives a reservation back. The caller must call this EXACTLY ONCE per
   * successful reserve() — `reserved` is shared across concurrent requests, so
   * releasing twice would hand back someone else's booking and let a later
   * request slip past the cap.
   */
  release(amount: number): void;
  /** USD already spent today (committed + reserved-in-flight). */
  spentToday(): number;
  /** Remaining headroom under the daily cap. */
  remainingToday(): number;
  /** Audit lookup for GET /api/remit/:txHash. Null when we never sent it. */
  find(txHash: string): RemitLogEntry | null;
}

export function hashRecipient(address: string): string {
  return createHash('sha256').update(address.toLowerCase()).digest('hex').slice(0, 12);
}

/** UTC day key, matching the hackathon's UTC-based counting window. */
export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

export class JsonlRemitLog implements RemitLog {
  private day: string;
  /** Committed USD for `day`, replayed from disk at boot. */
  private committed = 0;
  /** USD reserved by in-flight requests (not yet committed or released). */
  private reserved = 0;
  /**
   * txHash -> USD currently counted for it. A remittance is logged TWICE: once
   * as "pending" the moment it is broadcast (so a crash during the receipt wait
   * cannot forget money that is already moving), then again with its final
   * status. Keying by txHash makes the second write a CORRECTION, not a
   * double-count — and lets a revert give the budget back.
   */
  private readonly counted = new Map<string, number>();
  private dirReady = false;

  constructor(
    private readonly dailyCapUsd: number,
    private readonly filePath: string = DEFAULT_REMIT_LOG_FILE,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.day = utcDay(this.now());
    this.replayToday(); // rebuilds `committed` + `counted` from disk
    if (this.committed > 0) {
      console.log(
        `[remit] replayed ${this.committed.toFixed(2)} USD already sent today (${this.day}) ` +
          `from ${this.filePath} — daily cap ${this.dailyCapUsd} USD`,
      );
    }
  }

  /**
   * Rebuilds today's spend from the log file. A corrupt line is skipped with a
   * warning rather than crashing the boot — but note it can only ever make the
   * counter LOWER, so we log loudly.
   */
  private replayToday(): number {
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return 0; // no log yet: first run
    }

    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as RemitLogEntry;
        if (typeof entry.timestamp !== 'string' || typeof entry.amount !== 'number') continue;
        if (entry.timestamp.slice(0, 10) !== this.day) continue;
        // Same book() the live path uses: a tx logged pending-then-failed
        // replays to zero, and a tx logged only as pending still counts (the
        // funds moved even though we crashed before seeing the receipt).
        this.book(entry);
      } catch {
        console.warn(`[remit] skipping corrupt line in ${this.filePath}: ${trimmed.slice(0, 80)}`);
      }
    }
    return this.committed;
  }

  /** Rolls the counters over when the UTC day changes. */
  private rollDay(): void {
    const today = utcDay(this.now());
    if (today !== this.day) {
      this.day = today;
      this.committed = 0;
      this.reserved = 0;
      this.counted.clear();
    }
  }

  spentToday(): number {
    this.rollDay();
    return this.committed + this.reserved;
  }

  remainingToday(): number {
    return Math.max(0, this.dailyCapUsd - this.spentToday());
  }

  reserve(amount: number): boolean {
    this.rollDay();
    // Atomic: no await between the check and the booking.
    if (this.committed + this.reserved + amount > this.dailyCapUsd) {
      return false;
    }
    this.reserved += amount;
    return true;
  }

  release(amount: number): void {
    this.reserved = Math.max(0, this.reserved - amount);
  }

  /**
   * Books an entry against today's spend, idempotently per txHash.
   *
   * - first sight of a txHash (the "pending" write, at broadcast time): count it,
   *   because the funds are already moving;
   * - second write for the same txHash (the final status): a CORRECTION. Only a
   *   revert changes anything — it gives the budget back, since a reverted swap
   *   moved nothing.
   */
  private book(entry: RemitLogEntry): void {
    const key = entry.txHash?.toLowerCase();
    if (!key) {
      // Never broadcast: nothing to count (and nothing to correct later).
      return;
    }
    const alreadyCounted = this.counted.get(key);

    if (alreadyCounted === undefined) {
      const amount = entry.status === 'failed' ? 0 : entry.amount;
      this.counted.set(key, amount);
      this.committed += amount;
      return;
    }
    if (entry.status === 'failed' && alreadyCounted > 0) {
      this.committed -= alreadyCounted;
      this.counted.set(key, 0);
    }
    // success-after-pending: already counted at broadcast time, nothing to do.
  }

  /**
   * Scans the log for a tx hash. Linear over the file, which is fine: this is
   * a per-request audit lookup over a file that holds tens of lines, not a
   * hot path.
   */
  find(txHash: string): RemitLogEntry | null {
    const wanted = txHash.toLowerCase();
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch {
      return null;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as RemitLogEntry;
        if (entry.txHash?.toLowerCase() === wanted) return entry;
      } catch {
        // corrupt line: already warned about at boot
      }
    }
    return null;
  }

  commit(entry: RemitLogEntry): void {
    this.rollDay();
    this.book(entry);

    if (!this.dirReady) {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.dirReady = true;
    }
    appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    console.log(
      `[remit] ${entry.status} ${entry.corridor} $${entry.amount} -> ${entry.received} ` +
        `(tx=${entry.txHash ?? 'none'}, tag=${entry.tag ?? 'none'}, ` +
        `spent today=${this.committed.toFixed(2)}/${this.dailyCapUsd})`,
    );
  }
}
