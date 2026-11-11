import { jsonBody } from "../../_security";
import { changeNotesPin, getVaultStatus, lockNotesVault, SecureNotesError, setupNotesVault, unlockNotesVault } from "../../../../lib/secure-notes";
import { notesContext, notesError, notesResponse } from "../_security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET() {
  try {
    const { session, token } = await notesContext();
    return notesResponse(getVaultStatus(session, token));
  } catch (error) { return notesError(error); }
}
export async function POST(request: Request) {
  try {
    const { session, token } = await notesContext(request);
    const input = await jsonBody(request);
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new SecureNotesError(400, "提交的格式不正确。");
    if (input.action === "setup" || input.action === "unlock") {
      const result = input.action === "setup" ? await setupNotesVault(input, session) : await unlockNotesVault(input, session);
      return notesResponse(result.status, 200, result.token, result.status.expiresAt);
    }
    if (input.action === "lock") return notesResponse(lockNotesVault(session, token), 200, "", null);
    if (input.action === "changePin") return notesResponse(await changeNotesPin(input, session, token), 200, "", null);
    throw new SecureNotesError(400, "不支持的安全笔记操作。");
  } catch (error) { return notesError(error); }
}
