/**
 * Paid-query logger. Every served quote is appended to logs/queries.jsonl
 * (one JSON object per line) and echoed to stdout. IPs are never stored raw:
 * only the first 12 hex chars of their sha256.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// backend/src or backend/dist -> one level up = backend/logs
const DEFAULT_LOG_FILE = path.resolve(HERE, '../logs/queries.jsonl');

export interface QueryLogEntry {
  timestamp: string;
  pair: string;
  amount: number;
  /** Always null in mock mode; real tx hash once on-chain payments land. */
  txHash: string | null;
  ipHash: string;
}

export interface QueryLog {
  log(entry: QueryLogEntry): void;
}

export function hashIp(ip: string): string {
  return createHash('sha256').update(ip).digest('hex').slice(0, 12);
}

export class JsonlQueryLogger implements QueryLog {
  private dirReady = false;

  constructor(private readonly filePath: string = DEFAULT_LOG_FILE) {}

  log(entry: QueryLogEntry): void {
    if (!this.dirReady) {
      mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.dirReady = true;
    }
    appendFileSync(this.filePath, `${JSON.stringify(entry)}\n`, 'utf8');
    console.log(`[query] ${entry.pair} amount=${entry.amount} ip=${entry.ipHash}`);
  }
}
