/**
 * rlbotline Worker — Calculator Feature
 *
 * Safe math expression evaluator using recursive-descent parsing.
 * No eval() — supports +, -, *, /, parentheses, and decimal numbers.
 */

import { logger } from "../core/logger.js";
import { sendBotMessage } from "../core/line-client.js";
import type { Feature, BotCommand } from "../types.js";

// ─── Safe Expression Parser ──────────────────────────────────────

/**
 * Tokenizer: breaks expression string into number and operator tokens.
 */
type Token =
  | { type: "number"; value: number }
  | { type: "op"; value: string }
  | { type: "lparen" }
  | { type: "rparen" };

function tokenize(expression: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const expr = expression.replace(/\s+/g, "");

  while (i < expr.length) {
    const ch = expr[i];

    // Number (including decimals and negative numbers at start or after operator/lparen)
    if (
      ch >= "0" && ch <= "9" ||
      ch === "." ||
      (ch === "-" &&
        (i === 0 ||
          tokens[tokens.length - 1]?.type === "op" ||
          tokens[tokens.length - 1]?.type === "lparen"))
    ) {
      let numStr = "";
      if (ch === "-") {
        numStr += "-";
        i++;
      }
      let hasDot = false;
      while (i < expr.length && ((expr[i] >= "0" && expr[i] <= "9") || expr[i] === ".")) {
        if (expr[i] === ".") {
          if (hasDot) break;
          hasDot = true;
        }
        numStr += expr[i];
        i++;
      }
      const value = parseFloat(numStr);
      if (isNaN(value)) {
        throw new Error(`ตัวเลขไม่ถูกต้อง: "${numStr}"`);
      }
      tokens.push({ type: "number", value });
      continue;
    }

    if (ch === "+" || ch === "-" || ch === "*" || ch === "/") {
      tokens.push({ type: "op", value: ch });
      i++;
      continue;
    }

    if (ch === "(") {
      tokens.push({ type: "lparen" });
      i++;
      continue;
    }

    if (ch === ")") {
      tokens.push({ type: "rparen" });
      i++;
      continue;
    }

    throw new Error(`ตัวอักษรที่ไม่รู้จัก: "${ch}"`);
  }

  return tokens;
}

/**
 * Recursive-descent parser for math expressions.
 *
 * Grammar:
 *   expr   → term (('+' | '-') term)*
 *   term   → factor (('*' | '/') factor)*
 *   factor → NUMBER | '(' expr ')'
 */
class Parser {
  private tokens: Token[];
  private pos: number;

  constructor(tokens: Token[]) {
    this.tokens = tokens;
    this.pos = 0;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private consume(): Token {
    const token = this.tokens[this.pos];
    if (!token) throw new Error("นิพจน์ไม่สมบูรณ์");
    this.pos++;
    return token;
  }

  parse(): number {
    const result = this.expr();
    if (this.pos < this.tokens.length) {
      throw new Error("นิพจน์มีตัวอักษรเกินมา");
    }
    return result;
  }

  private expr(): number {
    let left = this.term();

    while (true) {
      const token = this.peek();
      if (
        token?.type === "op" &&
        (token.value === "+" || token.value === "-")
      ) {
        this.consume();
        const right = this.term();
        if (token.value === "+") {
          left += right;
        } else {
          left -= right;
        }
      } else {
        break;
      }
    }

    return left;
  }

  private term(): number {
    let left = this.factor();

    while (true) {
      const token = this.peek();
      if (
        token?.type === "op" &&
        (token.value === "*" || token.value === "/")
      ) {
        this.consume();
        const right = this.factor();
        if (token.value === "*") {
          left *= right;
        } else {
          if (right === 0) {
            throw new Error("หารด้วยศูนย์ไม่ได้");
          }
          left /= right;
        }
      } else {
        break;
      }
    }

    return left;
  }

  private factor(): number {
    const token = this.peek();

    if (!token) {
      throw new Error("นิพจน์ไม่สมบูรณ์");
    }

    if (token.type === "number") {
      this.consume();
      return token.value;
    }

    if (token.type === "lparen") {
      this.consume(); // consume '('
      const result = this.expr();
      const closing = this.consume();
      if (closing.type !== "rparen") {
        throw new Error("ขาดวงเล็บปิด ')'");
      }
      return result;
    }

    throw new Error(`ไม่คาดคิด: "${JSON.stringify(token)}"`);
  }
}

/**
 * Safely evaluate a mathematical expression string.
 * Returns the numeric result or throws with a user-friendly error.
 */
export function safeEvaluate(expression: string): number {
  if (expression.length > 200) {
    throw new Error("นิพจน์ยาวเกินไป (สูงสุด 200 ตัวอักษร)");
  }

  const tokens = tokenize(expression);
  if (tokens.length === 0) {
    throw new Error("นิพจน์ว่างเปล่า");
  }

  const parser = new Parser(tokens);
  return parser.parse();
}

/**
 * Format the result: remove trailing zeros for clean display.
 */
function formatResult(value: number): string {
  if (!isFinite(value)) {
    return "∞ (ไม่สิ้นสุด)";
  }
  // Round to 10 decimal places to avoid floating-point noise
  const rounded = Math.round(value * 1e10) / 1e10;
  return String(rounded);
}

/**
 * Create the Calculator feature.
 */
export function createCalculatorFeature(): Feature {
  return {
    name: "calculator",
    commands: ["calc", "c"],
    description: "🔢 เครื่องคิดเลข — !calc <นิพจน์> เช่น !calc 2+3*4",

    async handleCommand(cmd: BotCommand): Promise<void> {
      const expression = cmd.args.join(" ");

      if (!expression) {
        await sendBotMessage(cmd.chatId, "🔢 วิธีใช้: !calc <นิพจน์>\nเช่น: !calc 2+3*4\nรองรับ: + - * / ( )");
        return;
      }

      try {
        const result = safeEvaluate(expression);
        const formatted = formatResult(result);

        await sendBotMessage(cmd.chatId, `🔢 ${expression} = ${formatted}`);

        logger.debug("Calculator result", { expression, result: formatted });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);

        await sendBotMessage(cmd.chatId, `❌ คำนวณไม่ได้: ${msg}`);

        logger.debug("Calculator error", { expression, error: msg });
      }
    },
  };
}
