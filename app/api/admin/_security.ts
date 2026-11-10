import { getChatGPTUser } from "../../chatgpt-auth";
import { hasValidOrigin, trustedOrigin } from "../../lib/auth-core";
import { PromotionValidationError, SettingsValidationError } from "../../lib/directory";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export function authorizeOrigin(request: Request) {
  if (!trustedOrigin(request)) throw new ApiError(503, "管理员入口尚未配置完成，请联系网站拥有者。");
  if (!hasValidOrigin(request)) throw new ApiError(403, "无法验证请求来源，请刷新后再试。");
}

export async function authorizeAdmin(request?: Request, options?: { requireJson?: boolean }) {
  const user = await getChatGPTUser();
  if (!user) throw new ApiError(401, "登入已失效，请重新登入。");
  if (request && !["GET", "HEAD"].includes(request.method)) {
    authorizeOrigin(request);
    if (options?.requireJson !== false && !(request.headers.get("content-type") || "").toLowerCase().startsWith("application/json")) throw new ApiError(415, "请使用 JSON 格式。");
  }
  return user;
}

export function apiError(error: unknown) {
  if (error instanceof SettingsValidationError || error instanceof PromotionValidationError) return Response.json({ error: error.message }, { status: 400, headers: { "Cache-Control": "no-store" } });
  if (error instanceof ApiError) return Response.json({ error: error.message }, { status: error.status, headers: { "Cache-Control": "no-store" } });
  console.error("Directory operation failed:", error instanceof Error ? error.name : "UnknownError");
  return Response.json({ error: "暂时无法保存或读取内容，请稍后再试。" }, { status: 500, headers: { "Cache-Control": "no-store" } });
}
export function isUniqueConstraint(error: unknown) { return String(error).toUpperCase().includes("UNIQUE CONSTRAINT"); }
export async function jsonBody(request: Request) {
  const maxBytes = 30_000;
  const contentLength = Number(request.headers.get("content-length") || "0");
  if (contentLength > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    throw new ApiError(413, "提交的内容过大。");
  }
  if (!request.body) throw new ApiError(400, "提交的格式不正确。");
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ApiError(413, "提交的内容过大。");
      }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes));
    return JSON.parse(text);
  } catch { throw new ApiError(400, "提交的格式不正确。"); }
}
