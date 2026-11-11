"use client";

import { useEffect } from "react";

type AdminRequest = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
export type NotesVaultStatus = { configured: boolean; unlocked: boolean; expiresAt: number | null };
export const NOTES_ACTIVITY_EVENT = "365-notes-vault-activity";
const MIN_INTERVAL = 60_000;

// Real interactions anywhere in the administrator dashboard renew an existing
// PIN unlock. Timers only batch an interaction; an unattended page sends nothing.
export default function NotesActivity({ request }: { request: AdminRequest }) {
  useEffect(() => {
    let active = true;
    let inFlight = false;
    let pending = false;
    let timer = 0;
    let lastAttemptAt = -MIN_INTERVAL;
    function schedule() {
      if (!active || !pending || inFlight || document.hidden) return;
      window.clearTimeout(timer);
      const delay = Math.max(0, MIN_INTERVAL - (Date.now() - lastAttemptAt));
      if (delay) timer = window.setTimeout(() => { void send(); }, delay);
      else void send();
    }
    async function send() {
      timer = 0;
      if (!active || !pending || inFlight || document.hidden) return;
      pending = false; inFlight = true; lastAttemptAt = Date.now();
      try {
        const status = await request<NotesVaultStatus>("/api/admin/notes/vault", "POST", { action: "activity" });
        if (active && !document.hidden && typeof status.configured === "boolean" && typeof status.unlocked === "boolean") {
          // Only expiry/lock metadata travels through this in-memory event.
          window.dispatchEvent(new CustomEvent<NotesVaultStatus>(NOTES_ACTIVITY_EVENT, { detail: { configured: status.configured, unlocked: status.unlocked, expiresAt: status.expiresAt } }));
        }
      } catch { /* Authentication and connection errors are handled by each view. */ }
      finally { inFlight = false; schedule(); }
    }
    function interact(event: Event) {
      if (!event.isTrusted || document.hidden) return;
      pending = true; schedule();
    }
    function visibility(event: Event) {
      if (document.hidden) {
        pending = false; window.clearTimeout(timer); timer = 0;
      } else interact(event);
    }
    const inputEvents = ["pointerdown", "keydown", "input", "wheel", "touchstart"] as const;
    for (const event of inputEvents) window.addEventListener(event, interact, { passive: true });
    window.addEventListener("focus", interact);
    document.addEventListener("visibilitychange", visibility);
    // A visible page reload/navigation is an explicit dashboard visit.
    if (!document.hidden) { pending = true; schedule(); }
    return () => {
      active = false; pending = false; window.clearTimeout(timer);
      for (const event of inputEvents) window.removeEventListener(event, interact);
      window.removeEventListener("focus", interact);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [request]);
  return null;
}
