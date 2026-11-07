import { z } from "zod";
import { ApiError } from "./_security";
import { isSafeImageUrl, isUploadedImageUrl } from "../../lib/image-url";
import { normalizeBrandCategory, isSafeSocialUrl } from "../../lib/directory";

function isHttpUrl(value: string): boolean {
  if (!value) return true;
  try { return ["https:", "http:"].includes(new URL(value).protocol); } catch { return false; }
}

const safeUrl = z.string().trim().max(2048).refine(isHttpUrl, "请输入完整的 https:// 或 http:// 链接。");
const socialUrl = z.string().trim().max(2048).refine(value => value === "" || isSafeSocialUrl(value), "请输入完整的 http:// 或 https:// 联系链接。");

export const brandInput = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z.string().trim().min(1).max(100).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  category: z.enum(["All", "Update", "New", "Gaming", "Lifestyle", "Entertainment"]).optional().transform(normalizeBrandCategory),
  promotionDays: z.number().int().min(1).max(365).nullable().optional(),
  // Accepted for compatibility with full-object saves, but always ignored by
  // the repository: only the server can create a promotion deadline.
  promotionExpiresAt: z.number().int().safe().nullable().optional(),
  tagline: z.string().trim().max(180),
  description: z.string().trim().max(4000),
  color: z.string().regex(/^#[a-fA-F0-9]{6}$/),
  icon: z.string().trim().min(1).max(30),
  imageUrl: z.string().trim().max(2048).refine(value => isHttpUrl(value) || isUploadedImageUrl(value), "请上传照片或输入完整的图片链接。"),
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
  whatsappUrl: socialUrl.optional(),
  whatsappEnabled: z.boolean().optional(),
  telegramUrl: socialUrl.optional(),
  telegramEnabled: z.boolean().optional(),
  facebookUrl: socialUrl.optional(),
  facebookEnabled: z.boolean().optional(),
}).strict().superRefine((settings, context) => {
  for (const [name, urlKey, enabledKey] of [
    ["WhatsApp", "whatsappUrl", "whatsappEnabled"],
    ["Telegram", "telegramUrl", "telegramEnabled"],
    ["Facebook", "facebookUrl", "facebookEnabled"],
  ] as const) {
    if (settings[enabledKey] && settings[urlKey] === "") context.addIssue({ code: "custom", path: [urlKey], message: `请填写 ${name} 链接后再显示。` });
  }
});

export function validate<TSchema extends z.ZodTypeAny>(schema: TSchema, input: unknown): z.output<TSchema> {
  const result = schema.safeParse(input);
  if (!result.success) throw new ApiError(400, `请检查填写内容：${result.error.issues.map(i => `${i.path.join(".")} ${i.message}`).join("；")}`);
  return result.data;
}
