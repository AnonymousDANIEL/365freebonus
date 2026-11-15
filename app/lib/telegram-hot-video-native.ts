import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import bigInt from "big-integer";
import { Api, utils } from "teleproto";
import { CustomFile } from "teleproto/client/methods/uploads";
import { createTelegramAccountClient, hotVideoBotApplication } from "./telegram-account";
import { HotVideoError, hotVideoKeyboard } from "./telegram-hot-videos";
import { readHotVideoMetadata } from "./telegram-hot-video-mp4";

const CONTEXT = "365freebonus:hot-video-bot-session:v1";
const TEMP_ERROR = "大视频暂时未能连接 Telegram，稍后自动重试。";
type Session = { token_hash: string; application_revision: string; session_ciphertext: string };
export type HotVideoNativeReply = { ok: true; result: Record<string, unknown> } | { ok: false; code: number; retryAfter: number } | null;
function sessionKey() {
  const secret = process.env.SESSION_SECRET || "";
  if (secret.length < 32) throw new HotVideoError("服务器尚未配置视频会话加密，请联系管理员。", 503);
  return createHmac("sha256", secret).update(CONTEXT).digest();
}
function protect(value: string, aad: string): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", sessionKey(), iv);
  cipher.setAAD(Buffer.from(aad));
  const bytes = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), bytes.toString("base64url"), cipher.getAuthTag().toString("base64url")].join(".");
}
function reveal(value: string, aad: string): string {
  try {
    const [version, iv, bytes, tag, extra] = value.split(".");
    if (version !== "v1" || !iv || !bytes || !tag || extra) throw new Error();
    const cipher = createDecipheriv("aes-256-gcm", sessionKey(), Buffer.from(iv, "base64url"));
    cipher.setAAD(Buffer.from(aad)); cipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([cipher.update(Buffer.from(bytes, "base64url")), cipher.final()]).toString("utf8");
  } catch { throw new HotVideoError("大视频机器人会话无法读取，请检查服务器加密设置。", 409); }
}
type Reply = HotVideoNativeReply;
function rpcFailure(error: unknown): Exclude<Reply, { ok: true } | null> | null {
  const raw = error as { code?: number; seconds?: number; errorMessage?: string };
  if (!raw || typeof raw !== "object") return null;
  if ([400, 406].includes(Number(raw.code)) && raw.errorMessage === "CHANNEL_PRIVATE")
    return { ok: false, code: 403, retryAfter: 0 };
  if (raw.code === 420 && Number.isSafeInteger(raw.seconds) && Number(raw.seconds) > 0)
    return { ok: false, code: 429, retryAfter: Number(raw.seconds) };
  if ([400, 401, 403].includes(Number(raw.code)) && typeof raw.errorMessage === "string")
    return { ok: false, code: Number(raw.code), retryAfter: 0 };
  return null;
}
function markup() {
  return new Api.ReplyInlineMarkup({ rows: hotVideoKeyboard().map(row => new Api.KeyboardInlineButtonRow({
    buttons: row.map(button => new Api.KeyboardInlineButton({ text: button.text, type: new Api.InlineButtonTypeUrl({ url: button.url }) })),
  })) });
}
function regularVideo(document: unknown): document is Api.Document {
  return document instanceof Api.Document && document.mimeType === "video/mp4"
    && document.attributes.some(a => a instanceof Api.DocumentAttributeVideo && !a.roundMessage)
    && !document.attributes.some(a => a instanceof Api.DocumentAttributeAnimated);
}
function normalize(reply: Api.TypeUpdates, targetId: number, documentId: string, randomId: string): Reply {
  if (!(reply instanceof Api.Updates || reply instanceof Api.UpdatesCombined)) return null;
  const mapped = reply.updates.filter(u => u instanceof Api.UpdateMessageID && u.randomId?.toString() === randomId) as Api.UpdateMessageID[];
  if (mapped.length > 1) return null;
  const messages = reply.updates.flatMap(update => update instanceof Api.UpdateNewChannelMessage && update.message instanceof Api.Message ? [update.message] : []);
  const candidates = messages.filter(m => Number(utils.getPeerId(m.peerId)) === targetId
    && (mapped.length ? m.id === mapped[0].id : m.media instanceof Api.MessageMediaDocument && m.media.document instanceof Api.Document && m.media.document.id.toString() === documentId));
  if (candidates.length !== 1) return null;
  const message = candidates[0], media = message.media instanceof Api.MessageMediaDocument ? message.media.document : undefined;
  const video = regularVideo(media) && media.id.toString() === documentId && !message.fwdFrom;
  const inline_keyboard = message.replyMarkup instanceof Api.ReplyInlineMarkup ? message.replyMarkup.rows.map(row => row.buttons.map(button =>
    button.type instanceof Api.InlineButtonTypeUrl ? { text: button.text, url: button.type.url } : { text: button.text, unsupported: true })) : undefined;
  return { ok: true, result: { message_id: message.id, chat: { id: targetId }, caption: message.message,
    video: video ? { width: (media as Api.Document).attributes.find(a => a instanceof Api.DocumentAttributeVideo)?.w } : undefined,
    reply_markup: { inline_keyboard } } };
}

type NativeOperation = {
  db: DatabaseSync; token: string; botId: number; targetId: number; filename: string; bytes: number; jobId: string;
  valid: () => boolean; renew: () => void; onDispatch: () => void; checkOnly?: boolean;
  mode?: "upload" | "channel" | "source_check" | "marker"; sourceChatId?: number; sourceMessageId?: number;
  requireSourcePost?: boolean; expectedDocumentId?: string; targetMessageId?: number; markerId?: string;
};
const SENT_MARKER = "✅ Sent · Used";
const positiveId = (id: unknown): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0 && id <= 2147483647;
function markerReply(reply: Api.TypeUpdates, sourceChatId: number, sourceMessageId: number, randomId: string): Reply {
  if (!(reply instanceof Api.Updates || reply instanceof Api.UpdatesCombined)) return null;
  const mapped = reply.updates.filter(u => u instanceof Api.UpdateMessageID && u.randomId?.toString() === randomId) as Api.UpdateMessageID[];
  if (mapped.length !== 1) return null;
  const messages = reply.updates.flatMap(update => update instanceof Api.UpdateNewChannelMessage && update.message instanceof Api.Message ? [update.message] : []);
  const matching = messages.filter(m => m.id === mapped[0].id && Number(utils.getPeerId(m.peerId)) === sourceChatId
    && m.message === SENT_MARKER && !m.media && !m.fwdFrom && m.replyTo instanceof Api.MessageReplyHeader
    && m.replyTo.replyToMsgId === sourceMessageId && (!m.replyTo.replyToPeerId || Number(utils.getPeerId(m.replyTo.replyToPeerId)) === sourceChatId));
  if (matching.length !== 1) return null;
  return { ok: true, result: { message_id: matching[0].id, chat: { id: sourceChatId }, text: SENT_MARKER,
    reply_to_message: { message_id: sourceMessageId } } };
}
/** Independent bot authorization: never uses the owner's personal login session or an HTTP update poller. */
async function nativeHotVideoOperation(input: NativeOperation): Promise<Reply> {
  const mode = input.mode || "upload";
  if (mode !== "upload" && (typeof input.sourceChatId !== "number" || !Number.isSafeInteger(input.sourceChatId) || input.sourceChatId >= 0
    || mode !== "source_check" && (!positiveId(input.sourceMessageId) || input.sourceChatId === input.targetId)))
    throw new HotVideoError("请检查来源频道和视频消息编号。", 400);
  if (mode === "marker" && (!positiveId(input.targetMessageId) || !input.markerId)) throw new HotVideoError("已使用标记缺少已发送的视频凭证。", 400);
  const { db } = input;
  let application: ReturnType<typeof hotVideoBotApplication>;
  try { application = hotVideoBotApplication(db); }
  catch { throw new HotVideoError("请检查后台已保存的 Telegram API 应用设置，以启用原画大视频。", 409); }
  if (!application) throw new HotVideoError("请先在后台保存 Telegram API 应用设置，以启用原画大视频。", 409);
  const revision = application.revision, tokenHash = createHash("sha256").update(input.token).digest("hex"), aad = `${CONTEXT}:${input.botId}:${tokenHash}:${revision}`;
  const previous = db.prepare("SELECT token_hash,application_revision,session_ciphertext FROM telegram_hot_video_bot_sessions WHERE bot_id=?").get(input.botId) as Session | undefined;
  const session = previous?.token_hash === tokenHash && previous.application_revision === revision ? reveal(previous.session_ciphertext, aad) : "";
  const client = createTelegramAccountClient(application, session), deadline = Date.now() + (input.checkOnly ? 60_000 : mode === "upload" ? 15 * 60_000 : 90_000);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    if (Date.now() >= deadline || !input.valid()) throw new HotVideoError("视频发送设置已改变或处理时间已过期，本次发送已停止。", 409);
    const current = db.prepare("SELECT config_ciphertext FROM telegram_personal_account WHERE id='primary'").get() as { config_ciphertext: string } | undefined;
    if (!current || createHash("sha256").update(current.config_ciphertext).digest("hex") !== revision) throw new HotVideoError("Telegram API 应用设置已改变，请重新尝试。", 409);
    input.renew();
  };
  const invoke = <T extends Api.AnyRequest>(request: T) => {
    check(); return client.invoke(request, undefined, { maxRetryCount: 0, floodSleepThreshold: 0, timeout: 30_000 });
  };
  let attempted = false;
  try {
    const work = async (): Promise<Reply> => {
      check();
      const metadata = input.checkOnly || mode !== "upload" ? null : await readHotVideoMetadata(input.filename, input.bytes).catch(() => { throw new HotVideoError("视频没有可播放的 MP4 视频轨道，请选择完整的 MP4 视频。", 400); });
      await client.start({ botAuthToken: input.token }); check();
      const me = await client.getMe();
      if (!(me instanceof Api.User) || !me.bot || Number(me.id.toString()) !== input.botId || me.username?.toLowerCase() !== "freebonus365chatbot")
        throw new HotVideoError("大视频机器人身份不符，请重新检查 ChatBot 设置。", 409);
      const channel = async (id: number, target: boolean, post: boolean) => {
        const [channelId, peerType] = utils.resolveId(bigInt(id));
        if (peerType !== Api.PeerChannel) throw new HotVideoError(target ? "大视频目标必须是 Hot 私密频道。" : "视频来源必须是 Telegram 频道。", 409);
        // Telegram explicitly permits a zero access hash for bots; no personal-account peer data is reused.
        check(); const entity = await client.getEntity(new Api.InputPeerChannel({ channelId, accessHash: bigInt.zero })); check();
        if (!(entity instanceof Api.Channel) || Number(utils.getPeerId(entity)) !== id || !entity.broadcast || entity.left
          || target && (entity.username || entity.usernames?.some(u => u.active))
          || post && !(entity.creator || entity.adminRights?.postMessages))
          throw new HotVideoError(target ? "请检查 Hot 私密频道及 ChatBot 管理员发布权限。" : "请将 ChatBot 加入来源频道，并开启需要的管理员发布权限。", 403);
        if (!target && entity.noforwards) throw new HotVideoError("来源频道已开启内容保护，无法复制视频。", 400);
        return { entity, peer: new Api.InputPeerChannel({ channelId: entity.id, accessHash: entity.accessHash ?? bigInt.zero }) };
      };
      const target = mode === "source_check" ? null : await channel(input.targetId, true, true);
      const peer = target?.peer;
      db.prepare(`INSERT INTO telegram_hot_video_bot_sessions(bot_id,token_hash,application_revision,session_ciphertext,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(bot_id) DO UPDATE SET token_hash=excluded.token_hash,application_revision=excluded.application_revision,session_ciphertext=excluded.session_ciphertext,updated_at=excluded.updated_at`)
        .run(input.botId, tokenHash, revision, protect(client.session.save() as unknown as string, aad), Date.now());
      if (mode === "source_check") {
        const source = await channel(input.sourceChatId!, false, input.requireSourcePost !== false);
        return { ok: true, result: { ready: true, title: source.entity.title, username: source.entity.username || "" } };
      }
      if (input.checkOnly) return { ok: true, result: { ready: true } };
      if (!peer) throw new HotVideoError("视频目标未能确认。", 409);
      if (mode === "channel" || mode === "marker") {
        const source = await channel(input.sourceChatId!, false, mode === "marker" || input.requireSourcePost !== false);
        const readMessage = async (channelPeer: Api.InputPeerChannel, id: number, markedId: number, isSource = true) => {
          const result = await invoke(new Api.channels.GetMessages({ channel: new Api.InputChannel({ channelId: channelPeer.channelId, accessHash: channelPeer.accessHash }), id: [new Api.InputMessageID({ id })] }));
          check();
          if (!(result instanceof Api.messages.Messages || result instanceof Api.messages.ChannelMessages || result instanceof Api.messages.MessagesSlice))
            throw new HotVideoError("无法确认来源视频，视频可能已删除或机器人无法读取。", 404);
          const messages = result.messages.filter(m => m instanceof Api.Message && m.id === id && Number(utils.getPeerId(m.peerId)) === markedId) as Api.Message[];
          if (messages.length !== 1) throw new HotVideoError("无法确认来源视频，视频可能已删除或机器人无法读取。", 404);
          const message = messages[0], document = message.media instanceof Api.MessageMediaDocument ? message.media.document : undefined;
          if (isSource && (message.noforwards || message.media instanceof Api.MessageMediaDocument && message.media.ttlSeconds))
            throw new HotVideoError("来源视频已开启内容保护或限时观看，无法复制。", 400);
          if (!regularVideo(document)) throw new HotVideoError("来源消息不是可播放的 MP4 视频，请检查来源频道。", 400);
          return { message, document };
        };
        const original = await readMessage(source.peer, input.sourceMessageId!, input.sourceChatId!);
        if (input.expectedDocumentId && original.document.id.toString() !== input.expectedDocumentId)
          throw new HotVideoError("来源视频已被更换，请在来源频道重新发布视频后再同步。", 409);
        if (mode === "marker") {
          const posted = await readMessage(peer, input.targetMessageId!, input.targetId, false);
          if (posted.document.id.toString() !== original.document.id.toString()) throw new HotVideoError("已发送视频与来源不一致，未添加已使用标记。", 409);
          const randomId = bigInt(createHash("sha256").update(`hot-video-marker:${input.markerId}`).digest("hex").slice(0, 15), 16).add(1);
          const request = new Api.messages.SendMessage({ peer: source.peer, message: SENT_MARKER, noWebpage: true, randomId,
            replyTo: new Api.InputReplyToMessage({ replyToMsgId: input.sourceMessageId! }) });
          check(); input.onDispatch(); attempted = true;
          try { return markerReply(await client.invoke(request, undefined, { maxRetryCount: 0, floodSleepThreshold: 0, timeout: 30_000 }), input.sourceChatId!, input.sourceMessageId!, randomId.toString()); }
          catch (error) { return rpcFailure(error); }
        }
        const randomId = bigInt(createHash("sha256").update(`hot-video:${input.jobId}`).digest("hex").slice(0, 15), 16).add(1);
        const request = new Api.messages.SendMedia({ peer, media: new Api.InputMediaDocument({ id: utils.getInputDocument(original.document) }),
          message: "", randomId, replyMarkup: markup() });
        check(); input.onDispatch(); attempted = true;
        try { return normalize(await client.invoke(request, undefined, { maxRetryCount: 0, floodSleepThreshold: 0, timeout: 30_000 }), input.targetId, original.document.id.toString(), randomId.toString()); }
        catch (error) { return rpcFailure(error); }
      }
      if (!metadata) throw new HotVideoError("视频资料未能读取。", 400);
      let progressAt = 0;
      const file = await client.uploadFile({ file: new CustomFile("hot-video.mp4", input.bytes, input.filename), workers: 1, maxBufferSize: 1024 * 1024,
        onProgress: () => { if (Date.now() - progressAt >= 10_000) { check(); progressAt = Date.now(); } } });
      check();
      // UploadMedia registers a video without posting anything to the channel.
      const uploaded = await invoke(new Api.messages.UploadMedia({ peer: new Api.InputPeerEmpty(), media: new Api.InputMediaUploadedDocument({
        file, mimeType: "video/mp4", forceFile: false, attributes: [new Api.DocumentAttributeFilename({ fileName: "hot-video.mp4" }),
          new Api.DocumentAttributeVideo({ duration: metadata.duration, w: metadata.width, h: metadata.height, supportsStreaming: metadata.supportsStreaming })],
      }) }));
      if (!(uploaded instanceof Api.MessageMediaDocument) || !(uploaded.document instanceof Api.Document)
        || uploaded.document.mimeType !== "video/mp4" || !uploaded.document.attributes.some(a => a instanceof Api.DocumentAttributeVideo && !a.roundMessage))
        throw new HotVideoError("Telegram 未识别为可播放视频，本次未发布，请检查 MP4 视频格式。", 400);
      const randomId = bigInt(createHash("sha256").update(`hot-video:${input.jobId}`).digest("hex").slice(0, 15), 16).add(1);
      const request = new Api.messages.SendMedia({ peer, media: new Api.InputMediaDocument({ id: utils.getInputDocument(uploaded.document) }),
        message: "", randomId, replyMarkup: markup() });
      check(); input.onDispatch(); attempted = true;
      try {
        const result = await client.invoke(request, undefined, { maxRetryCount: 0, floodSleepThreshold: 0, timeout: 30_000 });
        return normalize(result, input.targetId, uploaded.document.id.toString(), randomId.toString());
      } catch (error) { return rpcFailure(error); }
    };
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { void client.disconnect().catch(() => undefined); reject(new HotVideoError(TEMP_ERROR, 503)); }, Math.max(1, deadline - Date.now())); timer.unref();
    })]);
  } catch (error) {
    if (attempted) return null;
    if (error instanceof HotVideoError) throw error;
    const failure = rpcFailure(error);
    throw new HotVideoError(failure?.code === 403 ? mode === "upload" ? "ChatBot 暂时没有 Hot 频道发布权限，请检查管理员设置。"
      : "请检查 ChatBot 在来源频道和 Hot 频道的读取及发布权限。" : TEMP_ERROR,
      failure?.code ?? 503, failure?.retryAfter ?? 0);
  } finally {
    if (timer) clearTimeout(timer);
    // Disconnect is local cleanup; never logs out/revokes the bot or changes Bot API polling.
    await Promise.race([client.disconnect().catch(() => undefined), new Promise(resolve => { const stop = setTimeout(resolve, 2000); stop.unref(); })]);
  }
}

export async function sendLargeHotVideo(input: {
  db: DatabaseSync; token: string; botId: number; targetId: number; filename: string; bytes: number; jobId: string;
  valid: () => boolean; renew: () => void; onDispatch: () => void; checkOnly?: boolean;
}): Promise<Reply> { return nativeHotVideoOperation(input); }

/** Copies cloud media by a fresh bot-owned reference; no video bytes reach the server. */
export async function sendHotChannelVideo(input: {
  db: DatabaseSync; token: string; botId: number; targetId: number; sourceChatId: number; sourceMessageId: number; jobId: string;
  valid: () => boolean; renew: () => void; onDispatch: () => void; requireSourcePost?: boolean; expectedDocumentId?: string;
}): Promise<Reply> { return nativeHotVideoOperation({ ...input, filename: "", bytes: 0, mode: "channel" }); }

/** A separate actual-send boundary for a source reply marker, after confirming the published video exists. */
export async function markHotChannelVideoUsed(input: {
  db: DatabaseSync; token: string; botId: number; targetId: number; sourceChatId: number; sourceMessageId: number; targetMessageId: number;
  markerId: string; expectedDocumentId?: string; valid: () => boolean; renew: () => void; onDispatch: () => void;
}): Promise<Reply> { return nativeHotVideoOperation({ ...input, filename: "", bytes: 0, jobId: "", mode: "marker" }); }

/** Checks source membership and required publishing rights without reading history or posting. */
export async function checkHotVideoSourceAccess(input: {
  db: DatabaseSync; token: string; botId: number; sourceChatId: number; requireSourcePost?: boolean; valid: () => boolean;
}): Promise<{ title: string; username: string }> {
  const result = await nativeHotVideoOperation({ ...input, targetId: 0, filename: "", bytes: 0, jobId: "", mode: "source_check",
    renew: () => undefined, onDispatch: () => { throw new HotVideoError("只读检查禁止发送消息。", 409); } });
  if (!result?.ok || result.result.ready !== true || typeof result.result.title !== "string" || typeof result.result.username !== "string")
    throw new HotVideoError("无法确认来源频道权限，请稍后重试。", 503);
  return { title: result.result.title, username: result.result.username };
}

/** Read-only production check: authorizes the bot and verifies private-channel rights, never uploads/posts media. */
export async function checkLargeHotVideoAccess(input: {
  db: DatabaseSync; token: string; botId: number; targetId: number; valid: () => boolean;
}) {
  const result = await sendLargeHotVideo({ ...input, filename: "", bytes: 0, jobId: "", checkOnly: true, renew: () => undefined,
    onDispatch: () => { throw new HotVideoError("只读检查禁止发送消息。", 409); } });
  return result?.ok === true && result.result.ready === true;
}
