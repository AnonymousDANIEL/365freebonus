import { randomBytes } from "node:crypto";
import { request } from "node:https";

type TelegramMethod = "getMe" | "getChat" | "getChatMember" | "getWebhookInfo" | "getFile" | "sendMessage" | "sendPhoto" | "sendAnimation" | "sendVideo" | "sendDocument" | "editMessageCaption" | "createChatInviteLink";
type TelegramBooleanMethod = "approveChatJoinRequest" | "declineChatJoinRequest" | "banChatMember" | "unbanChatMember";
export type TelegramUpload = { field: "photo" | "animation" | "video" | "document"; fileName: string; mime: string; bytes: Buffer };
type TelegramReply<Result> =
  | { ok: true; result: Result }
  | { ok: false; code: number; retryAfter: number }
  | null;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function asUpdates(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null;
  const records = value.map(asRecord);
  return records.every(record => record !== null) ? records : null;
}

function parseReply<Result>(body: string, parseResult: (value: unknown) => Result | null): TelegramReply<Result> {
  const reply = asRecord(JSON.parse(body));
  if (reply?.ok === true) {
    const result = parseResult(reply.result);
    return result !== null ? { ok: true, result } : null;
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

function requestTelegram<Result>(token: string, method: TelegramMethod | TelegramBooleanMethod | "getUpdates" | "answerCallbackQuery", parameters: Record<string, unknown>, parseResult: (value: unknown) => Result | null, upload?: TelegramUpload): Promise<TelegramReply<Result>> {
  // Telegram requires the token in the request path. Use Node HTTPS directly so
  // Next's fetch tracing never sees that URL, and keep raw replies private.
  return new Promise(resolve => {
    const maxReplyLength = method === "getUpdates" ? 524_288 : 65_536;
    const { body, contentType } = upload
      ? multipartPayload(parameters, upload)
      : { body: JSON.stringify(parameters), contentType: "application/json" };
    const outgoing = request({
      hostname: "api.telegram.org",
      method: "POST",
      path: `/bot${token}/${method}`,
      headers: { "Content-Type": contentType, "Content-Length": Buffer.byteLength(body) },
      signal: AbortSignal.timeout(upload && (upload.field === "video" || upload.mime.startsWith("video/")) ? 40_000 : upload || method === "getUpdates" ? 20_000 : 8_000),
    }, response => {
      let content = "";
      response.setEncoding("utf8");
      response.on("data", chunk => {
        content += chunk;
        if (content.length > maxReplyLength) response.destroy();
      });
      response.on("end", () => {
        try { resolve(parseReply(content, parseResult)); }
        catch { resolve(null); }
      });
      response.on("error", () => resolve(null));
      response.on("close", () => resolve(null));
    });
    outgoing.on("error", () => resolve(null));
    outgoing.end(body);
  });
}

export function telegramRequest(token: string, method: TelegramMethod, parameters: Record<string, unknown> = {}, upload?: TelegramUpload) {
  return requestTelegram(token, method, parameters, asRecord, upload);
}

/** Moderation methods return true, rather than a Message or Chat object. */
export function telegramBooleanRequest(token: string, method: TelegramBooleanMethod, parameters: Record<string, unknown>) {
  return requestTelegram(token, method, parameters, value => value === true ? true : null);
}

export function telegramUpdates(token: string, offset: number) {
  return requestTelegram(token, "getUpdates", { offset, timeout: 10, limit: 10, allowed_updates: ["chat_member", "message", "callback_query", "chat_join_request", "my_chat_member", "channel_post"] }, asUpdates);
}

/** The promotion bot owns a separate update stream from the private ChatBot. */
export function telegramRelayUpdates(token: string, offset: number) {
  return requestTelegram(token, "getUpdates", { offset, timeout: 10, limit: 20, allowed_updates: ["message", "channel_post", "my_chat_member"] }, asUpdates);
}

export async function answerTelegramCallback(token: string, queryId: string): Promise<boolean> {
  const reply = await requestTelegram(token, "answerCallbackQuery", { callback_query_id: queryId }, value => value === true ? true : null);
  return reply?.ok === true;
}
