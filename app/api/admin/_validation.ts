import { z } from "zod";
import { ApiError } from "./_security";
import { isSafeImageUrl } from "../../lib/image-url";

const safeUrl = z.string().trim().max(2048).refine(value => {
  if (!value) return true;
  try { return ["https:", "http:"].includes(new URL(value).protocol); } catch { return false; }
}, "请输入完整的 https:// 或 http:// 链接。");

export const brandInput = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z.string().trim().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  category: z.enum(["Gaming", "Lifestyle", "Entertainment"]),
  tagline: z.string().trim().max(180),
  description: z.string().trim().max(4000),
  color: z.string().regex(/^#[a-fA-F0-9]{6}$/),
  icon: z.string().trim().min(1).max(30),
  imageUrl: safeUrl,
  featured: z.boolean(),
  published: z.boolean(),
  sortOrder: z.number().int().min(0).max(99999),
  link: safeUrl,
}).strict();

export const settingsInput = z.object({
  name: z.string().trim().min(1).max(40),
  eyebrow: z.string().trim().max(100),
  headline: z.string().trim().min(1).max(120),
  description: z.string().trim().max(1000),
  announcement: z.string().trim().max(300),
  contactUrl: safeUrl,
  coverImageUrl: z.string().trim().max(2048).refine(isSafeImageUrl, "请输入 HTTPS 图片网址或以 / 开始的站内图片路径。").optional(),
  avatarImageUrl: z.string().trim().max(2048).refine(isSafeImageUrl, "请输入 HTTPS 图片网址或以 / 开始的站内图片路径。").optional(),
}).strict();

export function validate<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(400, `请检查填写内容：${result.error.issues.map(i => `${i.path.join(".")} ${i.message}`).join("；")}`);
  return result.data;
}
