import { request } from "node:https";

type TelegramMethod = "getMe" | "getChat" | "getChatMember" | "sendMessage";
type TelegramReply =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; code: number; retryAfter: number }
  | null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseReply(body: string): TelegramReply {
  const reply = asRecord(JSON.parse(body));
  if (reply?.ok === true) {
    const result = asRecord(reply.result);
    return result ? { ok: true, result } : null;
  }
  if (reply?.ok !== false || typeof reply.error_code !== "number") return null;
  const seconds = asRecord(reply.parameters)?.retry_after;
  return {
    ok: false,
    code: reply.error_code,
    retryAfter: typeof seconds === "number" && Number.isSafeInteger(seconds) && seconds > 0 ? seconds : 0,
  };
}

export function telegramRequest(token: string, method: TelegramMethod, parameters: Record<string, unknown> = {}): Promise<TelegramReply> {
  // Telegram requires the token in the request path. Use Node HTTPS directly so
  // Next's fetch tracing never sees that URL, and keep raw replies private.
  return new Promise(resolve => {
    const body = JSON.stringify(parameters);
    const outgoing = request({
      hostname: "api.telegram.org",
      method: "POST",
      path: `/bot${token}/${method}`,
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
      signal: AbortSignal.timeout(8_000),
    }, response => {
      let content = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        content += chunk;
        if (content.length > 65_536) response.destroy();
      });
      response.on("end", () => {
        try { resolve(parseReply(content)); }
        catch { resolve(null); }
      });
      response.on("error", () => resolve(null));
      response.on("close", () => resolve(null));
    });
    outgoing.on("error", () => resolve(null));
    outgoing.end(body);
  });
}
