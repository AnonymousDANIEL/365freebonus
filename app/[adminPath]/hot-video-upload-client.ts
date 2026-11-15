export type HotVideoUploadSession = {
  id: string; requestId: string; bytes: number; receivedBytes: number; chunkBytes: number;
  state: "uploading" | "complete"; expiresAt: number | null; videoId: string | null;
};
export type SavedHotVideoUpload = HotVideoUploadSession & {
  originalName: string; lastModified: number; title: string;
};
export type UploadFile = Pick<File, "name" | "size" | "lastModified" | "slice">;
export type UploadProgress = { acknowledgedBytes: number; loadedBytes: number; totalBytes: number;
  phase: "preparing" | "uploading" | "reconnecting" | "verifying" };
export type UploadRequest = {
  method: "GET" | "POST" | "PUT" | "DELETE"; path: string; json?: unknown; body?: ArrayBuffer;
  headers?: Record<string, string>; signal?: AbortSignal; onProgress?: (bytes: number) => void;
};
export type UploadReply = { status: number; body: unknown; retryAfterMs?: number };
export type UploadTransport = (request: UploadRequest) => Promise<UploadReply>;
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type ErrorKind = "network" | "file_read" | "aborted" | "http" | "protocol";
export class HotVideoUploadError extends Error {
  constructor(message: string, readonly status = 0, readonly kind: ErrorKind = "http", readonly retryAfterMs = 0) { super(message); }
}

const endpoint = "/api/admin/telegram/hot-videos/uploads";
const storageKey = "365freebonus:hot-video-uploads:v1";
const maxBytes = 50 * 1024 * 1024, maxChunkBytes = 1024 * 1024, uploadTtl = 10 * 60_000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const integer = (value: unknown, minimum = 0): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
function browserStorage(): StorageLike | null { try { return typeof window === "undefined" ? null : window.sessionStorage; } catch { return null; } }
function aborted(signal?: AbortSignal) { if (signal?.aborted) throw new HotVideoUploadError("上传已停止。", 0, "aborted"); }
function errorValue(error: unknown): HotVideoUploadError {
  return error instanceof HotVideoUploadError ? error : new HotVideoUploadError("连接中断，上传进度已保留，请稍后继续。", 0, "network");
}
function failure(reply: UploadReply): HotVideoUploadError {
  const body = record(reply.body), text = typeof body?.error === "string" ? body.error : reply.status === 401 ? "登入已失效，请重新登入后继续上传。"
    : reply.status === 410 ? "上次上传进度已过期，请重新上传。" : "视频上传暂时未能完成，请稍后继续。";
  return new HotVideoUploadError(text, reply.status, "http", reply.retryAfterMs || 0);
}
function successful(reply: UploadReply) { if (reply.status < 200 || reply.status >= 300) throw failure(reply); return reply.body; }
function retryable(error: HotVideoUploadError) {
  return error.kind === "network" || error.kind === "protocol" || error.status === 408 || error.status === 429 || error.status >= 500;
}
function session(value: unknown, id: string, bytes: number): HotVideoUploadSession {
  const v = record(value);
  if (!v || v.id !== id || v.requestId !== id || v.bytes !== bytes || !integer(v.receivedBytes) || v.receivedBytes > bytes
    || !integer(v.chunkBytes, 1) || v.chunkBytes > maxChunkBytes || !["uploading", "complete"].includes(String(v.state))
    || !(v.expiresAt === null || integer(v.expiresAt, 1)) || !(v.videoId === null || typeof v.videoId === "string" && uuid.test(v.videoId))
    || v.state === "complete" && (v.receivedBytes !== bytes || v.videoId === null)) {
    throw new HotVideoUploadError("未能确认已保存的上传进度，请稍后继续。", 0, "protocol");
  }
  return v as unknown as HotVideoUploadSession;
}
function metadataMatches(file: UploadFile, value: SavedHotVideoUpload) {
  return value.originalName === file.name && value.bytes === file.size && value.lastModified === file.lastModified;
}
export function getHotVideoUploadResumes(storage: StorageLike | null = browserStorage(), now = Date.now()): SavedHotVideoUpload[] {
  if (!storage) return [];
  try {
    const values: unknown = JSON.parse(storage.getItem(storageKey) || "[]");
    if (!Array.isArray(values)) return [];
    return values.slice(-4).flatMap(raw => {
      const value = record(raw);
      if (!value || typeof value.id !== "string" || !uuid.test(value.id) || !integer(value.bytes, 24) || value.bytes > maxBytes
        || typeof value.originalName !== "string" || value.originalName.length > 255 || typeof value.title !== "string" || !value.title.trim() || value.title.length > 160
        || !integer(value.lastModified) || value.expiresAt !== null && (!integer(value.expiresAt, 1) || value.expiresAt <= now)) return [];
      try { return [{ ...session(value, value.id, value.bytes), originalName: value.originalName, title: value.title, lastModified: value.lastModified }]; }
      catch { return []; }
    });
  } catch { return []; }
}
function saveResume(value: SavedHotVideoUpload, storage: StorageLike | null) {
  if (!storage) return;
  try { storage.setItem(storageKey, JSON.stringify([...getHotVideoUploadResumes(storage).filter(item => item.id !== value.id), value].slice(-4))); } catch { /* Upload still resumes in this running operation. */ }
}
export function forgetHotVideoUpload(id: string, storage: StorageLike | null = browserStorage()) {
  if (!storage) return;
  try {
    const next = getHotVideoUploadResumes(storage).filter(value => value.id !== id);
    if (next.length) storage.setItem(storageKey, JSON.stringify(next)); else storage.removeItem(storageKey);
  } catch { /* Browser storage may be disabled; no file data is cached. */ }
}
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  aborted(signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => { clearTimeout(timer); reject(new HotVideoUploadError("上传已停止。", 0, "aborted")); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Only small in-memory buffers reach XHR; the browser never streams an original disk File. */
export function xhrHotVideoUploadRequest(request: UploadRequest): Promise<UploadReply> {
  aborted(request.signal);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const finish = (error?: HotVideoUploadError, reply?: UploadReply) => {
      if (settled) return; settled = true;
      request.signal?.removeEventListener("abort", onAbort);
      if (error) reject(error); else resolve(reply!);
    };
    const onAbort = () => { xhr.abort(); finish(new HotVideoUploadError("上传已停止。", 0, "aborted")); };
    xhr.open(request.method, request.path);
    xhr.withCredentials = true; xhr.timeout = request.body ? 90_000 : 45_000;
    xhr.setRequestHeader("Accept", "application/json");
    if (request.body) xhr.setRequestHeader("Content-Type", "application/octet-stream");
    else if (request.method !== "GET") xhr.setRequestHeader("Content-Type", "application/json");
    for (const [name, value] of Object.entries(request.headers || {})) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = event => { if (event.loaded >= 0) request.onProgress?.(event.loaded); };
    xhr.onload = () => {
      if (!xhr.status) { finish(new HotVideoUploadError("连接中断，上传进度已保留，请稍后继续。", 0, "network")); return; }
      let body: unknown;
      try { body = JSON.parse(xhr.responseText); } catch { body = null; }
      const rawDelay = xhr.getResponseHeader("Retry-After") || "", seconds = Number(rawDelay);
      const retryAfterMs = rawDelay && Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 0;
      finish(undefined, { status: xhr.status, body, retryAfterMs });
    };
    xhr.onerror = () => finish(new HotVideoUploadError("连接中断，上传进度已保留，请稍后继续。", 0, "network"));
    xhr.ontimeout = () => finish(new HotVideoUploadError("连接超时，上传进度已保留，请稍后继续。", 0, "network"));
    xhr.onabort = () => finish(new HotVideoUploadError("上传已停止。", 0, "aborted"));
    request.signal?.addEventListener("abort", onAbort, { once: true });
    if (request.signal?.aborted) { onAbort(); return; }
    xhr.send(request.body || (request.method === "GET" ? null : JSON.stringify(request.json ?? {})));
  });
}

export async function uploadHotVideoFile<Result>(options: {
  file: UploadFile; title: string; signal?: AbortSignal; onProgress?: (progress: UploadProgress) => void;
  onSession?: (saved: SavedHotVideoUpload) => void; transport?: UploadTransport; storage?: StorageLike | null;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>; newId?: () => string;
}): Promise<Result> {
  const { file, signal } = options, transport = options.transport || xhrHotVideoUploadRequest;
  const storage = options.storage === undefined ? browserStorage() : options.storage, sleep = options.sleep || wait;
  if (!Number.isSafeInteger(file.size) || file.size < 24 || file.size > maxBytes || !/\.mp4$/i.test(file.name)
    || file.name.length > 255 || /[\u0000-\u001f\u007f]/u.test(file.name) || !integer(file.lastModified))
    throw new HotVideoUploadError("请选择不超过 50 MB 的 MP4 视频。", 400);
  const fallbackTitle = options.title.trim() || file.name.replace(/\.mp4$/i, "").trim() || "Video";
  if (fallbackTitle.length > 160 || /[\u0000-\u001f\u007f]/u.test(fallbackTitle))
    throw new HotVideoUploadError("请使用不超过 160 字的后台视频名称。", 400);
  const newId = () => {
    const value = (options.newId || (() => crypto.randomUUID()))();
    if (!uuid.test(value)) throw new HotVideoUploadError("无法建立上传编号，请刷新页面后重试。", 400);
    return value;
  };
  const progress = (current: HotVideoUploadSession | null, phase: UploadProgress["phase"], loadedBytes = 0) => options.onProgress?.({
    acknowledgedBytes: current?.receivedBytes || 0, loadedBytes, totalBytes: file.size, phase,
  });
  async function read(start: number, end: number) {
    aborted(signal);
    let bytes: ArrayBuffer;
    try { bytes = await file.slice(start, end).arrayBuffer(); }
    catch { throw new HotVideoUploadError("浏览器无法读取本地视频，请重新选择文件，并勿修改、移动或删除原文件。", 0, "file_read"); }
    aborted(signal);
    if (bytes.byteLength !== end - start) throw new HotVideoUploadError("本地视频未能完整读取，请重新选择文件，并勿修改、移动或删除原文件。", 0, "file_read");
    return bytes;
  }
  progress(null, "preparing");
  await read(0, Math.min(64, file.size));
  let saved = getHotVideoUploadResumes(storage).find(value => metadataMatches(file, value));
  let id = saved?.id || newId();
  let title = saved?.title ?? fallbackTitle;
  let current: HotVideoUploadSession | null = null;
  let established = Boolean(saved);
  const persist = (value: HotVideoUploadSession) => {
    current = value;
    saved = { ...value, originalName: file.name, lastModified: file.lastModified, title };
    saveResume(saved, storage); options.onSession?.(saved);
  };
  async function delay(attempt: number, error: HotVideoUploadError) {
    if (error.retryAfterMs > 60_000) throw error;
    progress(current, "reconnecting");
    await sleep(Math.max(attempt * 1000, error.retryAfterMs), signal); aborted(signal);
  }
  async function request(make: () => UploadRequest): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      aborted(signal);
      try { return successful(await transport({ ...make(), signal })); }
      catch (raw) {
        const error = errorValue(raw);
        if (error.kind === "aborted" || !retryable(error) || attempt >= 3) throw error;
        await delay(attempt, error);
      }
    }
  }
  const get = async () => session(await request(() => ({ method: "GET", path: `${endpoint}/${id}` })), id, file.size);
  try {
    if (saved) {
      try { persist(await get()); established = true; }
      catch (error) {
        if (!(error instanceof HotVideoUploadError) || ![404, 410].includes(error.status)) throw error;
        forgetHotVideoUpload(id, storage); saved = undefined; established = false; id = newId(); title = fallbackTitle;
      }
    }
    if (!current) {
      const pending: HotVideoUploadSession = { id, requestId: id, bytes: file.size, receivedBytes: 0, chunkBytes: maxChunkBytes,
        state: "uploading", expiresAt: Date.now() + uploadTtl, videoId: null };
      persist(pending);
      persist(session(await request(() => ({ method: "POST", path: endpoint,
        json: { requestId: id, title, originalName: file.name, bytes: file.size } })), id, file.size));
      established = true;
    }
    while (current!.state !== "complete" && current!.receivedBytes < file.size) {
      let accepted = false;
      for (let attempt = 1; !accepted; attempt++) {
        const before = current!, offset = before.receivedBytes, end = Math.min(file.size, offset + before.chunkBytes);
        progress(before, "uploading");
        const bytes = await read(offset, end);
        try {
          const response = await transport({ method: "PUT", path: `${endpoint}/${id}`, signal, body: bytes,
            headers: { "X-Video-Offset": String(offset) }, onProgress: loaded => progress(before, "uploading", Math.min(bytes.byteLength, loaded)) });
          const received = session(successful(response), id, file.size);
          if (received.receivedBytes !== end) throw new HotVideoUploadError("未能确认完整上传进度，请稍后继续。", 0, "protocol");
          persist(received); progress(received, "uploading"); accepted = true;
        } catch (raw) {
          const error = errorValue(raw);
          if (error.kind === "aborted" || !retryable(error) && error.status !== 409) throw error;
          if (error.status !== 409 && attempt < 3) await delay(attempt, error);
          const confirmed = await get();
          if (confirmed.receivedBytes < offset) throw new HotVideoUploadError("服务器上传进度发生变化，请重新选择同一视频后继续。", 409);
          persist(confirmed);
          if (confirmed.receivedBytes !== offset || confirmed.state === "complete") accepted = true;
          else if (error.status === 409) throw error;
          else if (attempt >= 3) throw error;
        }
      }
    }
    progress(current, "verifying");
    let body: unknown;
    for (let attempt = 1; ; attempt++) {
      aborted(signal);
      try {
        body = successful(await transport({ method: "POST", path: `${endpoint}/${id}/complete`, json: {}, signal }));
        if (!record(body) || !Array.isArray(record(body)!.videos)) throw new HotVideoUploadError("视频已上传，未能确认保存结果，请稍后继续核对。", 0, "protocol");
        break;
      } catch (raw) {
        const error = errorValue(raw);
        if (error.kind === "aborted" || !retryable(error) || attempt >= 3) throw error;
        await delay(attempt, error); persist(await get());
      }
    }
    forgetHotVideoUpload(id, storage);
    return body as Result;
  } catch (error) {
    if (error instanceof HotVideoUploadError && ([404, 410].includes(error.status)
      || !established && error.status >= 400 && error.status < 500 && error.status !== 429)) forgetHotVideoUpload(id, storage);
    throw error;
  }
}

export async function cancelHotVideoUpload(id: string, options: { transport?: UploadTransport; storage?: StorageLike | null } = {}) {
  if (!uuid.test(id)) throw new HotVideoUploadError("上传编号无效。", 400);
  const transport = options.transport || xhrHotVideoUploadRequest;
  for (let attempt = 1; ; attempt++) {
    try {
      const reply = await transport({ method: "DELETE", path: `${endpoint}/${id}`, json: {} });
      if (![404, 410].includes(reply.status)) successful(reply);
      forgetHotVideoUpload(id, options.storage === undefined ? browserStorage() : options.storage); return;
    } catch (raw) {
      const error = errorValue(raw);
      if (attempt >= 3 || !retryable(error) && error.status !== 409) throw error;
      await wait(attempt * 1000);
    }
  }
}
