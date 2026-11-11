export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.NEXT_PHASE === "phase-production-build") return;
  const { startTelegramPromotionWorker } = await import("./app/lib/telegram-promotions");
  startTelegramPromotionWorker();
  const { startWebsiteLoginWorker } = await import("./app/lib/website-login-worker");
  startWebsiteLoginWorker();
}
