import { requireChatGPTUser } from "../chatgpt-auth";
import AdminClient from "./AdminClient";
import "./admin.css";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = await requireChatGPTUser("/admin");
  return <AdminClient displayName={user.displayName} />;
}
