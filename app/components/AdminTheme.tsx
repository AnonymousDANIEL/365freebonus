"use client";

import { useSyncExternalStore } from "react";
import { Moon, Sun } from "lucide-react";
import styles from "./AdminTheme.module.css";

export type AdminTheme = "light" | "dark";
const storageKey = "365freebonus-admin-theme";
const changedEvent = "365freebonus-admin-theme-change";
let memoryTheme: AdminTheme | null = null;

function getSnapshot(): AdminTheme {
  if (typeof window === "undefined") return "light";
  if (memoryTheme) return memoryTheme;
  try {
    const saved = window.localStorage.getItem(storageKey);
    if (saved === "light" || saved === "dark") return saved;
  } catch { /* Browser privacy settings may disable persistent storage. */ }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function subscribe(onChange: () => void) {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const onStorage = (event: StorageEvent) => {
    if (event.key === storageKey || event.key === null) { memoryTheme = null; onChange(); }
  };
  window.addEventListener("storage", onStorage);
  window.addEventListener(changedEvent, onChange);
  media.addEventListener("change", onChange);
  return () => {
    window.removeEventListener("storage", onStorage);
    window.removeEventListener(changedEvent, onChange);
    media.removeEventListener("change", onChange);
  };
}

function setTheme(theme: AdminTheme) {
  memoryTheme = theme;
  try { window.localStorage.setItem(storageKey, theme); } catch { /* Keep this tab usable when storage is unavailable. */ }
  window.dispatchEvent(new Event(changedEvent));
}

export function useAdminTheme() {
  // A constant server snapshot keeps SSR and the first hydration render equal.
  // React then resolves the saved/browser preference without replacing the page.
  const theme = useSyncExternalStore(subscribe, getSnapshot, () => "light" as AdminTheme);
  return { theme, setTheme };
}

export function AdminThemeToggle({ theme, onChange }: { theme: AdminTheme; onChange: (theme: AdminTheme) => void }) {
  return <div className={styles.toggle} data-theme={theme} role="group" aria-label="后台显示模式">
    <button type="button" aria-label="切换到亮色模式" aria-pressed={theme === "light"} onClick={() => onChange("light")}><Sun size={14} aria-hidden="true" /><span>亮色</span></button>
    <button type="button" aria-label="切换到深色模式" aria-pressed={theme === "dark"} onClick={() => onChange("dark")}><Moon size={14} aria-hidden="true" /><span>深色</span></button>
  </div>;
}
