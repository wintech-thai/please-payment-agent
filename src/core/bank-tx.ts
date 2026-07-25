/**
 * rlbotline Worker — Bank transaction parser
 *
 * Parses a bank-OA flex message (msg.text = stringified flex JSON, see
 * event-router's flex extraction) into a structured `BankTx`. Together with
 * `shouldForwardOaMessage()` it forms the bank-OA forward filter — active only
 * when FILTER_EVENT is set, and failing open for OAs whose templates we don't
 * know yet (see that function's doc).
 *
 * Label/value extraction relies on the observed SCB Connect + Krungthai
 * Connext templates (captured in `.req/`): a value text-node always directly
 * follows its label text-node in document order.
 */

export interface BankTx {
  event: "bank_tx";
  /** Filterable event name — matched against FILTER_EVENT. */
  eventType: "tx_in" | "tx_out";
  direction: "in" | "out";
  /** Transaction amount, always positive (sign lives in `direction`). */
  amount: number;
  /** "SCB" | "KTB" — mapped from the OA name; falls back to the raw chat name. */
  bank: string;
  chatName: string;
  /** Unix ms — receive time at the worker. */
  receivedAt: number;
  /** "ยอดเงินที่ใช้ได้" / "ยอดที่ใช้ได้" — present only when the bank sent it. */
  balance?: number;
  /** Our account (abbreviated, as the bank displays it). */
  account?: string;
  /** บัญชีผู้โอน (เลขบัญชีล้วน ไม่มีชื่อธนาคาร) — in: "จากบัญชี" (counterparty), out: our account. */
  sourceAccount?: string;
  /** บัญชีผู้รับ (เลขบัญชีล้วน ไม่มีชื่อธนาคาร) — in: our account, out: "ไปยังบัญชี" (counterparty). */
  destinationAccount?: string;
  /** ธนาคารต้นทาง — our bank (out) or detected from the counterparty text (in); "unknown" when undetectable. */
  sourceBank: string;
  /** ธนาคารปลายทาง — our bank (in) or detected from the counterparty/memo text (out); "unknown" when undetectable. */
  destinationBank: string;
  /** ชื่อผู้โอน — "ผู้โอน" (KTB in). */
  sourceAccountName?: string;
  /** ชื่อผู้รับ — "ผู้รับโอน" (KTB out). */
  destinationAccountName?: string;
  /** "ประเภท" (KTB) / "รายการ" (SCB out). */
  memo?: string;
  /** Bank-formatted date string, not normalized. */
  txDate?: string;
  /** Parsed flex object (or the original string when text wasn't JSON). */
  text: unknown;
}

/** Collect `.text` of every flex text-node in document order. */
function collectTexts(node: unknown, out: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectTexts(item, out);
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const obj = node as Record<string, unknown>;
  if (obj["type"] === "text" && typeof obj["text"] === "string") {
    out.push(obj["text"]);
  }
  for (const value of Object.values(obj)) collectTexts(value, out);
}

/** "19,116.39 บาท" / "+2,000.00" → 19116.39 / 2000 (undefined when not numeric). */
function parseAmount(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[^\d.]/g, "");
  if (!cleaned) return undefined;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

/** Bank-name tokens (EN codes + Thai names) → normalized bank code. */
const BANK_PATTERNS: Array<[RegExp, string]> = [
  [/scb|ไทยพาณิชย์/i, "SCB"],
  [/ktb|krungthai|กรุงไทย/i, "KTB"],
  [/kbank|กสิกร/i, "KBANK"],
  [/bbl|กรุงเทพ/i, "BBL"],
  [/bay|กรุงศรี/i, "BAY"],
  [/ttb|ทหารไทย/i, "TTB"],
  [/gsb|ออมสิน/i, "GSB"],
];

/** First bank code found in the text, or null. */
function detectBank(s: string | undefined): string | null {
  if (!s) return null;
  for (const [re, code] of BANK_PATTERNS) if (re.test(s)) return code;
  return null;
}

/** Remove bank-name tokens from an account string ("SCB XX9148" → "XX9148"). */
function stripBankTokens(s: string): string {
  return s
    .replace(/\b(SCB|KTB|Krungthai|KBANK|BBL|BAY|TTB|GSB)\b/gi, "")
    .replace(/ไทยพาณิชย์|กรุงไทย|กสิกร(ไทย)?|กรุงเทพ|กรุงศรี(อยุธยา)?|ทหารไทย(ธนชาต)?|ออมสิน/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split an account string into number + holder name after stripping bank
 * tokens: "SUEBPONG MONS X-3090\nกรุงไทย" → { account: "X-3090", name:
 * "SUEBPONG MONS" }. No masked-number token found → whole string as account.
 */
function splitAccount(s: string): { account: string; name?: string } {
  const cleaned = stripBankTokens(s);
  const m = cleaned.match(/[Xx]+-?\d+/);
  if (!m) return { account: cleaned };
  const name = cleaned.replace(m[0], "").replace(/\s+/g, " ").trim();
  return { account: m[0], name: name || undefined };
}

/** Bank code for OAs whose message templates we can parse; null = unknown pattern. */
export function knownBank(chatName: string): "SCB" | "KTB" | null {
  if (/scb/i.test(chatName)) return "SCB";
  if (/krungthai|ktb/i.test(chatName)) return "KTB";
  return null;
}

/**
 * OA forward gate:
 * - FILTER_EVENT unset → forward every message (no filtering at all)
 * - FILTER_EVENT set:
 *   - parsed tx → forward only when its eventType is listed
 *   - known-bank OA but not a tx (promo / rich-menu text) → drop
 *   - unknown-pattern OA → fail open, forward every message
 */
export function shouldForwardOaMessage(
  chatName: string,
  tx: BankTx | null,
  filterEvent: string[],
): boolean {
  if (filterEvent.length === 0) return true;
  if (tx) return filterEvent.includes(tx.eventType);
  return knownBank(chatName) === null;
}

export function parseBankTx(
  chatName: string,
  text: string,
  receivedAt: number,
): BankTx | null {
  let flex: unknown;
  let texts: string[];
  try {
    flex = JSON.parse(text);
    texts = [];
    collectTexts(flex, texts);
  } catch {
    // Plain text (rich-menu taps etc.) — no direction header, filtered below.
    flex = undefined;
    texts = [text];
  }
  const trimmed = texts.map((t) => t.trim());

  // Direction header: SCB "รายการเงินเข้า/ออก", KTB "เงินเข้า/ออก". Exact match
  // so promo copy mentioning transfers can't slip through.
  const header = trimmed.find((t) => /^(รายการ)?เงิน(เข้า|ออก)$/.test(t));
  if (!header) return null;
  const direction = header.endsWith("เข้า") ? "in" : "out";

  const amount = parseAmount(trimmed.find((t) => /^[+-][\d,]+(\.\d+)?/.test(t)));
  if (amount === undefined) return null;

  const valueAfter = (label: RegExp): string | undefined => {
    const i = trimmed.findIndex((t) => label.test(t));
    return i >= 0 ? trimmed[i + 1] : undefined;
  };

  const bank = knownBank(chatName) ?? chatName;

  const tx: BankTx = {
    event: "bank_tx",
    eventType: direction === "in" ? "tx_in" : "tx_out",
    direction,
    amount,
    bank,
    chatName,
    receivedAt,
    sourceBank: "unknown",
    destinationBank: "unknown",
    text: flex ?? text,
  };

  const balance = parseAmount(valueAfter(/^ยอด(เงิน)?ที่ใช้ได้$/));
  if (balance !== undefined) tx.balance = balance;

  const memo = valueAfter(/^(ประเภท|รายการ)$/);

  // in: money flows จากบัญชี (source) → เข้าบัญชี (ours, destination)
  // out: money flows จากบัญชี (ours, source) → ไปยังบัญชี (destination)
  const sourceRaw = valueAfter(/^จากบัญชี$/);
  const destinationRaw =
    direction === "in" ? valueAfter(/^เข้าบัญชี$/) : valueAfter(/^ไปยังบัญชี$/);
  const source = sourceRaw ? splitAccount(sourceRaw) : undefined;
  const destination = destinationRaw ? splitAccount(destinationRaw) : undefined;
  if (source?.account) tx.sourceAccount = source.account;
  if (destination?.account) tx.destinationAccount = destination.account;

  // Our side's bank is the OA itself; the counterparty bank is detected from
  // its account text (falling back to memo — SCB out only names the target
  // bank inside "รายการ", e.g. "DSC-โอนไป KTB x3090 ...").
  tx.sourceBank =
    (direction === "in" ? detectBank(sourceRaw) : knownBank(chatName)) ?? "unknown";
  tx.destinationBank =
    (direction === "in" ? knownBank(chatName) : detectBank(destinationRaw ?? memo)) ?? "unknown";

  const account = direction === "in" ? destination?.account : source?.account;
  if (account) tx.account = account;

  // Explicit ผู้โอน/ผู้รับโอน label (KTB) wins; else the holder name embedded
  // in the account text (SCB in: "SUEBPONG MONS X-3090").
  const sourceAccountName = valueAfter(/^ผู้โอน$/) ?? source?.name;
  if (sourceAccountName) tx.sourceAccountName = sourceAccountName;
  const destinationAccountName = valueAfter(/^ผู้รับโอน$/) ?? destination?.name;
  if (destinationAccountName) tx.destinationAccountName = destinationAccountName;

  if (memo) tx.memo = memo;

  const txDate = valueAfter(/^(วันที่\/เวลา|วันที่ทำรายการ)$/);
  if (txDate) tx.txDate = txDate;

  return tx;
}
