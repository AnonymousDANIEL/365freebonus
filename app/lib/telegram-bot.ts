import { randomBytes } from "node:crypto";
import { request } from "node:https";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

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

type PrivateUpload = { path: string; fileName: string; bytes: number };
type PrivateMediaKind = "photo" | "animation" | "video";
const privateMediaMethods = { photo: "sendPhoto", animation: "sendAnimation", video: "sendVideo" } as const;
const privateMediaLimits = { photo: 10 * 1024 * 1024, animation: 20 * 1024 * 1024, video: 50 * 1024 * 1024 } as const;

/** Stream one private MP4 for the Hot video workflow, which has no caption. */
export async function telegramVideoFileRequest(token: string, parameters: Record<string, unknown>, upload: PrivateUpload) {
  if (Object.keys(parameters).some(key => !["chat_id", "reply_markup", "supports_streaming", "disable_notification"].includes(key))) return null;
  return telegramPrivateMediaFileRequest(token, parameters, upload, "video", "video/mp4");
}

/** Scheduled posts send the caption and attachment in one Telegram message. */
export async function telegramScheduledMediaFileRequest(token: string, chatId: number, caption: string,
  upload: PrivateUpload & { kind: PrivateMediaKind; mime: string }) {
  const mediaMimes = { photo: ["image/jpeg", "image/png"], animation: ["image/gif"], video: ["video/mp4"] };
  if (!mediaMimes[upload.kind]?.includes(upload.mime) || caption.length > 1024) return null;
  return telegramPrivateMediaFileRequest(token, { chat_id: chatId, caption }, upload, upload.kind, upload.mime);
}

async function telegramPrivateMediaFileRequest(token: string, parameters: Record<string, unknown>,
  upload: PrivateUpload, kind: PrivateMediaKind, mime: string): Promise<TelegramReply<Record<string, unknown>>> {
  if (!Number.isSafeInteger(upload.bytes) || upload.bytes < (kind === "video" ? 24 : 1) || upload.bytes > privateMediaLimits[kind]) return null;
  let handle: Awaited<ReturnType<typeof open>>;
  try { handle = await open(upload.path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return null; }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size !== upload.bytes) return null;
    const boundary = `365freebonus-${randomBytes(18).toString("hex")}`;
    const parts: Buffer[] = [];
    for (const [name, value] of Object.entries(parameters)) if (value !== undefined) {
      const content = typeof value === "string" ? value : JSON.stringify(value);
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${content}\r\n`));
    }
    const fileName = upload.fileName.replace(/[^A-Za-z0-9_.-]/g, "_") || (kind === "video" ? "video.mp4" : `${kind}.bin`);
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${kind}"; filename="${fileName}"\r\nContent-Type: ${mime}\r\n\r\n`));
    const prefix = Buffer.concat(parts), suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
    if (prefix.length > 65_536) return null;
    return await new Promise<TelegramReply<Record<string, unknown>>>(resolve => {
      const source = handle.createReadStream({ autoClose: false, highWaterMark: 64 * 1024 });
      let total = 0;
      const body = Readable.from((async function* () {
        yield prefix;
        for await (const chunk of source) {
          total += chunk.length;
          if (total > upload.bytes) throw new Error("Media size changed.");
          yield chunk;
        }
        if (total !== upload.bytes) throw new Error("Media size changed.");
        yield suffix;
      })());
      let settled = false;
      const finish = (value: TelegramReply<Record<string, unknown>>) => {
        if (settled) return;
        settled = true; body.destroy(); source.destroy(); resolve(value);
      };
      const outgoing = request({ hostname: "api.telegram.org", method: "POST", path: `/bot${token}/${privateMediaMethods[kind]}`,
        headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, "Content-Length": prefix.length + upload.bytes + suffix.length },
        signal: AbortSignal.timeout(kind === "photo" ? 20_000 : 40_000),
      }, response => {
        let content = "";
        response.setEncoding("utf8");
        response.on("data", chunk => { content += chunk; if (content.length > 65_536) response.destroy(); });
        response.on("end", () => { try { finish(parseReply(content, asRecord)); } catch { finish(null); } });
        response.on("error", () => finish(null)); response.on("close", () => finish(null));
      });
      outgoing.on("error", () => finish(null));
      void pipeline(body, outgoing).catch(() => finish(null));
    });
  } catch { return null; }
  finally { await handle.close().catch(() => undefined); }
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
  return requestTelegram(token, "getUpdates", { offset, timeout: 10, limit: 20, allowed_updates: ["message", "channel_post", "edited_message", "edited_channel_post", "my_chat_member"] }, asUpdates);
}

export async function answerTelegramCallback(token: string, queryId: string): Promise<boolean> {
  const reply = await requestTelegram(token, "answerCallbackQuery", { callback_query_id: queryId }, value => value === true ? true : null);
  return reply?.ok === true;
}
