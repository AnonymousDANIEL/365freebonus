import { jsonBody } from "../../_security";
import { deleteSecureNote, notesId, saveSecureNote } from "../../../../lib/secure-notes";
import { notesContext, notesError, notesResponse } from "../_security";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
export async function PUT(request: Request, context: Context) {
  try {
    const { session, token } = await notesContext(request);
    const id = notesId((await context.params).id);
    const input = await jsonBody(request);
    return notesResponse({ note: saveSecureNote(input, session, token, id) });
  } catch (error) { return notesError(error); }
}
export async function DELETE(request: Request, context: Context) {
  try {
    const { session, token } = await notesContext(request);
    const id = notesId((await context.params).id);
    const input = await jsonBody(request);
    deleteSecureNote(input, session, token, id);
    return notesResponse({ ok: true });
  } catch (error) { return notesError(error); }
}
