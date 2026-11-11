import { jsonBody } from "../_security";
import { listSecureNotes, saveSecureNote } from "../../../lib/secure-notes";
import { notesContext, notesError, notesResponse } from "./_security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const { session, token } = await notesContext();
    return notesResponse(listSecureNotes(session, token, Number(new URL(request.url).searchParams.get("page") || 1)));
  } catch (error) { return notesError(error); }
}
export async function POST(request: Request) {
  try {
    const { session, token } = await notesContext(request);
    const input = await jsonBody(request);
    return notesResponse({ note: saveSecureNote(input, session, token) }, 201);
  } catch (error) { return notesError(error); }
}
