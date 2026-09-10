import {
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, parse, resolve, sep } from "node:path";
// macOS exposes these two stable system aliases; every other parent symlink fails closed.

const PROCESS_PRIVATE_LEDGER_ROOT_KEY = "__piSubagenturaCompletionLedgerRoot";

interface PrivateLedgerGlobalState {
  __piSubagenturaCompletionLedgerRoot?: string;
}

/** Process-lifetime fallback root for managers that cannot expose a session dir. */
export function getProcessPrivateLedgerRoot(): string {
  const state = globalThis as typeof globalThis & PrivateLedgerGlobalState;
  const existing = state[PROCESS_PRIVATE_LEDGER_ROOT_KEY];
  if (typeof existing === "string" && existing.length > 0) return existing;
  const root = mkdtempSync(join(tmpdir(), "pi-subagentura-completion-"));
  chmodSync(root, 0o700);
  state[PROCESS_PRIVATE_LEDGER_ROOT_KEY] = root;
  return root;
}

function darwinRootAlias(
  root: string,
  current: string,
  next: string,
  part: string,
): string | undefined {
  if (process.platform !== "darwin" || current !== root) return undefined;
  if (part !== "tmp" && part !== "var") {
    return undefined;
  }
  const canonical = `/private/${part}`;
  return realpathSync(next) === canonical ? canonical : undefined;
}

export interface LedgerReadResult {
  lines: string[];
  truncated: boolean;
}

export interface LedgerAppendResult {
  ok: boolean;
  dropped: number;
}

export interface LedgerScanOptions {
  /** Do not expose receipts from a prior append whose sync may have failed. */
  syncBeforeRead?: boolean;
  startOffset?: number;
  includeUnterminated?: boolean;
  dropping?: boolean;
  /** Maximum physical bytes read from this fixed snapshot. */
  maxScanBytes?: number;
  /** Maximum complete lines delivered to onLine. */
  maxRecords?: number;
}

export interface LedgerScanResult {
  snapshotSize: number;
  nextOffset: number;
  dropping: boolean;
  scannedBytes: number;
  acceptedRecords: number;
  /** The snapshot was not fully checked due to a scan/record bound or partial tail. */
  truncated: boolean;
}

function ensureLedgerParent(path: string): void {
  const parent = dirname(resolve(path));
  const root = parse(parent).root;
  const relative = parent.slice(root.length);
  let current = root;
  for (const part of relative.split(sep).filter(Boolean)) {
    const next = join(current, part);
    try {
      const stat = lstatSync(next);
      if (stat.isSymbolicLink()) {
        const alias = darwinRootAlias(root, current, next, part);
        if (alias) {
          current = alias;
          continue;
        }
        throw new Error(`Ledger parent is not a directory: ${next}`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Ledger parent is not a directory: ${next}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(next, { mode: 0o700 });
      const stat = lstatSync(next);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Ledger parent is not a directory: ${next}`);
      }
    }
    if (part === ".pi") chmodSync(next, 0o700);
    current = next;
  }
}

function noFollow(): number {
  return constants.O_NOFOLLOW ?? 0;
}

function assertRegularLedger(path: string): void {
  const linkStat = lstatSync(path);
  if (!linkStat.isFile())
    throw new Error(`Ledger is not a regular file: ${path}`);
}

function openLedger(path: string, flags: number, mode?: number): number {
  ensureLedgerParent(path);
  try {
    assertRegularLedger(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const fd = openSync(path, flags | noFollow(), mode);
  const stat = fstatSync(fd);
  if (!stat.isFile()) {
    closeSync(fd);
    throw new Error(`Ledger is not a regular file: ${path}`);
  }
  fchmodSync(fd, 0o600);
  return fd;
}

export function sessionLedgerPath(
  cwd: string,
  sessionId: string | undefined,
  name: string,
): string {
  const identity = sessionId ?? "unknown-session";
  const suffix = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 16);
  return join(cwd, ".pi", `${name}-${suffix}.ndjson`);
}

export function readLedgerLines(
  path: string,
  maxBytes: number,
  options: Pick<LedgerScanOptions, "syncBeforeRead"> = {},
): LedgerReadResult {
  let fd: number | undefined;
  try {
    fd = openLedger(path, constants.O_RDONLY);
    const stat = fstatSync(fd);
    if (options.syncBeforeRead) fsyncSync(fd);
    const start = Math.max(0, stat.size - maxBytes);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const read = readSync(
        fd,
        buffer,
        offset,
        length - offset,
        start + offset,
      );
      if (read <= 0) break;
      offset += read;
    }
    let text = buffer.subarray(0, offset).toString("utf8");
    const truncated = start > 0;
    if (truncated) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline < 0 ? "" : text.slice(firstNewline + 1);
    }
    return {
      lines: text.split("\n").filter(Boolean),
      truncated,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { lines: [], truncated: false };
    }
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function writeLedger(path: string, lines: string[]): void {
  ensureLedgerParent(path);
  try {
    assertRegularLedger(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow(),
      0o600,
    );
    const content = lines.length > 0 ? `${lines.join("\n")}\n` : "";
    writeSync(fd, content, undefined, "utf8");
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      /* The temporary file may have been renamed successfully. */
    }
  }
  try {
    assertRegularLedger(path);
  } catch {
    throw new Error(`Ledger rename did not produce a regular file: ${path}`);
  }
}

export function appendLedgerLine(
  path: string,
  line: string,
  limits: { maxRecords: number; maxBytes: number },
): LedgerAppendResult {
  const loaded = readLedgerLines(path, limits.maxBytes);
  const lines = [...loaded.lines, line];
  let dropped = loaded.truncated ? 1 : 0;
  while (
    lines.length > limits.maxRecords ||
    Buffer.byteLength(`${lines.join("\n")}\n`, "utf8") > limits.maxBytes
  ) {
    lines.shift();
    dropped++;
  }
  writeLedger(path, lines);
  return { ok: true, dropped };
}

export function appendLedgerLineLossless(path: string, line: string): void {
  let fd: number | undefined;
  try {
    fd = openLedger(
      path,
      constants.O_RDWR | constants.O_APPEND | constants.O_CREAT,
      0o600,
    );
    const stat = fstatSync(fd);
    if (stat.size > 0) {
      const lastByte = Buffer.alloc(1);
      const bytesRead = readSync(fd, lastByte, 0, 1, stat.size - 1);
      if (bytesRead !== 1) {
        throw new Error(`Ledger tail read made no progress: ${path}`);
      }
      if (lastByte[0] !== 0x0a) {
        const separator = Buffer.from("\n", "utf8");
        const separatorWritten = writeSync(
          fd,
          separator,
          0,
          separator.length,
          null,
        );
        if (separatorWritten !== separator.length) {
          throw new Error(`Ledger separator write was incomplete: ${path}`);
        }
      }
    }
    const content = Buffer.from(`${line}\n`, "utf8");
    let offset = 0;
    while (offset < content.length) {
      const written = writeSync(
        fd,
        content,
        offset,
        content.length - offset,
        null,
      );
      if (written <= 0)
        throw new Error(`Ledger write made no progress: ${path}`);
      offset += written;
    }
    fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function scanLedgerLines(
  path: string,
  maxLineBytes: number,
  onLine: (line: string) => void,
  options: LedgerScanOptions = {},
): LedgerScanResult {
  let fd: number | undefined;
  try {
    fd = openLedger(path, constants.O_RDONLY);
    const snapshotSize = fstatSync(fd).size;
    if (options.syncBeforeRead) fsyncSync(fd);
    const requestedStart =
      typeof options.startOffset === "number" &&
      Number.isSafeInteger(options.startOffset)
        ? Math.max(0, options.startOffset)
        : 0;
    const startOffset =
      requestedStart > snapshotSize
        ? 0
        : Math.min(requestedStart, snapshotSize);
    const includeUnterminated = options.includeUnterminated !== false;
    const maxScanBytes =
      options.maxScanBytes === undefined
        ? Number.POSITIVE_INFINITY
        : Number.isSafeInteger(options.maxScanBytes) &&
            options.maxScanBytes >= 0
          ? options.maxScanBytes
          : 0;
    const maxRecords =
      options.maxRecords === undefined
        ? Number.POSITIVE_INFINITY
        : Number.isSafeInteger(options.maxRecords) && options.maxRecords >= 0
          ? options.maxRecords
          : 0;
    const chunk = Buffer.alloc(64 * 1024);
    let offset = startOffset;
    let lastCompleteOffset = startOffset;
    let carry = Buffer.alloc(0);
    let dropping = requestedStart <= snapshotSize && options.dropping === true;
    let scannedBytes = 0;
    let acceptedRecords = 0;
    let truncated = false;

    while (offset < snapshotSize) {
      if (scannedBytes >= maxScanBytes || acceptedRecords >= maxRecords) {
        truncated = true;
        break;
      }
      const bytesToRead = Math.min(
        chunk.length,
        snapshotSize - offset,
        maxScanBytes - scannedBytes,
      );
      if (bytesToRead <= 0) {
        truncated = true;
        break;
      }
      const bytesRead = readSync(fd, chunk, 0, bytesToRead, offset);
      if (bytesRead <= 0) {
        truncated = true;
        break;
      }
      const data = chunk.subarray(0, bytesRead);
      let cursor = 0;
      let stopForRecordLimit = false;
      while (cursor < data.length) {
        const newline = data.indexOf(0x0a, cursor);
        const segmentEnd = newline < 0 ? data.length : newline;
        const segment = data.subarray(cursor, segmentEnd);

        if (dropping) {
          if (newline < 0) {
            cursor = data.length;
          } else {
            dropping = false;
            carry = Buffer.alloc(0);
            lastCompleteOffset = offset + newline + 1;
            cursor = newline + 1;
          }
          continue;
        }

        if (carry.length + segment.length > maxLineBytes) {
          carry = Buffer.alloc(0);
          if (newline < 0) {
            dropping = true;
            cursor = data.length;
          } else {
            lastCompleteOffset = offset + newline + 1;
            cursor = newline + 1;
          }
          continue;
        }

        if (segment.length > 0) {
          carry =
            carry.length === 0
              ? Buffer.from(segment)
              : Buffer.concat([carry, segment]);
        }
        if (newline < 0) {
          cursor = data.length;
          continue;
        }
        if (acceptedRecords >= maxRecords) {
          truncated = true;
          stopForRecordLimit = true;
          break;
        }
        onLine(carry.toString("utf8"));
        acceptedRecords++;
        carry = Buffer.alloc(0);
        lastCompleteOffset = offset + newline + 1;
        cursor = newline + 1;
      }
      scannedBytes += bytesRead;
      offset += bytesRead;
      if (stopForRecordLimit) break;
    }

    if (!truncated && !dropping && carry.length > 0) {
      if (includeUnterminated) {
        if (acceptedRecords >= maxRecords) {
          truncated = true;
        } else {
          onLine(carry.toString("utf8"));
          acceptedRecords++;
          return {
            snapshotSize,
            nextOffset: offset,
            dropping: false,
            scannedBytes,
            acceptedRecords,
            truncated: false,
          };
        }
      } else {
        truncated = true;
      }
    }
    if (!truncated && offset < snapshotSize) truncated = true;
    return {
      snapshotSize,
      nextOffset: truncated
        ? dropping
          ? offset
          : lastCompleteOffset
        : dropping
          ? offset
          : lastCompleteOffset,
      dropping,
      scannedBytes,
      acceptedRecords,
      truncated,
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
