import { ApiError, apiError } from "../_security";
import { WebsiteSettingsError } from "../../../lib/website-logins";
import { WebsiteLoginError } from "../../../lib/website-login-client";
export function websiteError(error: unknown) {
  if (error instanceof WebsiteSettingsError || error instanceof WebsiteLoginError) return apiError(new ApiError(error.status, error.message));
  return apiError(error);
}
export function websiteId(value: string) {
  const id = Number(value);
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(id)) throw new ApiError(400, "网站编号不正确。");
  return id;
}
