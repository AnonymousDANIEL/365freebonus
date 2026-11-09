import { randomBytes } from "node:crypto";
import { request } from "node:https";

type TelegramMethod = "getMe" | "getChat" | "getChatMember" | "sendMessage" | "sendPhoto" | "sendAnimation" | "sendDocument";
export type TelegramUpload = { field: "photo" | "animation" | "document"; fileName: string; mime: string; bytes: Buffer };
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

function multipartPayload(parameters: Record<string, unknown>, upload: TelegramUpload) {
  const boundary = `365freebonus-${randomBytes(18).toString("hex")}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(parameters)) {
    if (value === undefined) continue;
    if (!/^[A-Za-z0-9_]+$/.test(name)) throw new TypeError("Invalid Telegram upload field name.");
    const content = typeof value === "string" ? value : JSON.stringify(value);
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${content}\r\n`));
  }
  const fileName = upload.fileName.replace(/[^A-Za-z0-9_.-]/g, "_") || `${upload.field}.bin`;
  const mime = /^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(upload.mime) ? upload.mime : "application/octet-stream";
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${upload.field}"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`),
    upload.bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

export function telegramRequest(token: string, method: TelegramMethod, parameters: Record<string, unknown> = {}, upload?: TelegramUpload): Promise<TelegramReply> {
  // Telegram requires the token in the request path. Use Node HTTPS directly so
  // Next's fetch tracing never sees that URL, and keep raw replies private.
  return new Promise(resolve => {
    const { body, contentType } = upload
      ? multipartPayload(parameters, upload)
      : { body: JSON.stringify(parameters), contentType: "application/json" };
    const outgoing = request({
      hostname: "api.telegram.org",
      method: "POST",
      path: `/bot${token}/${method}`,
      headers: { "Content-Type": contentType, "Content-Length": Buffer.byteLength(body) },
      signal: AbortSignal.timeout(upload ? 20_000 : 8_000),
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
