import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import ts from "typescript";

const fixture = mkdtempSync(path.join(tmpdir(), "telegram-game-tips-"));
symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), path.join(fixture, "node_modules"));
for (const source of ["telegram-game-tips-types", "telegram-game-tips"]) {
  const input = readFileSync(new URL(`../app/lib/${source}.ts`, import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(input, { compilerOptions: {
    esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
  } });
  writeFileSync(path.join(fixture, `${source}.js`), outputText);
}
const require = createRequire(import.meta.url);
const { deleteGameTipsAsset, gameTipsBackgroundPreview, gameTipsImagePreview, gameTipsLibrary, gameTipsLogoPreview,
  gameTipsPosterPreview, gameTipsProviderBackgroundId, gameTipsProviderLogo, gameTipsProviders, listGameTipAssets, renderGameTips,
  releaseDeletedGameTipsAssets, removeGameTipsPlatformPart, updateGameTipsAsset, updateGameTipsBackgroundSlots, updateGameTipsPlatform,
  uploadGameTipsAsset, uploadGameTipsBackground, uploadGameTipsLogo } =
  require(path.join(fixture, "telegram-game-tips.js"));
const { GAME_TIPS_DEFAULT_SLOTS, validGameTipsBackgroundSlots } = require(path.join(fixture, "telegram-game-tips-types.js"));

test.after(() => rmSync(fixture, { recursive: true, force: true }));

function database(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  return db;
}

async function png(color = "#f0f000") {
  return await sharp({ create: { width: 160, height: 100, channels: 3, background: color } }).png().toBuffer();
}

function uploadRequest(image, { id = randomUUID(), provider = "MEGA888", game = "Dolphin Reef", contentType = "image/png", length } = {}) {
  const query = new URLSearchParams({ id, provider, game });
  return new Request(`https://directory.example/api/admin/telegram/game-tips?${query}`, {
    method: "POST",
    headers: { "content-type": contentType, ...(length && { "content-length": length }) },
    body: image,
  });
}

function logoRequest(image, { id = randomUUID(), provider = "MEGA888", previousProvider, previousId = "", contentType = "image/png" } = {}) {
  const query = new URLSearchParams({ id, provider, previousId });
  if (previousProvider !== undefined) query.set("previousProvider", previousProvider);
  return new Request(`https://directory.example/api/admin/telegram/game-tips/logo?${query}`, {
    method: "POST", headers: { "content-type": contentType }, body: image,
  });
}

function backgroundRequest(image, { id = randomUUID(), provider = "MEGA888", previousId = "", slots, contentType = "image/png" } = {}) {
  const query = new URLSearchParams({ id, provider, previousId, ...(slots && { slots: JSON.stringify(slots) }) });
  return new Request(`https://directory.example/api/admin/telegram/game-tips/background?${query}`, {
    method: "POST", headers: { "content-type": contentType }, body: image,
  });
}

test("uploads are idempotent by upload ID and all original input while edits preserve stored image bytes", async t => {
  const db = database(t), id = randomUUID(), image = await png();
  const created = await uploadGameTipsAsset(db, uploadRequest(image, { id }), () => 30000);
  assert.deepEqual(created.providers, [{ name: "MEGA888", count: 1 }]);
  assert.deepEqual(created.assets[0], { id, provider: "MEGA888", game: "Dolphin Reef", enabled: true, createdAt: 30000, updatedAt: 30000 });
  assert.deepEqual(await uploadGameTipsAsset(db, uploadRequest(image, { id }), () => 55000), created);
  await assert.rejects(uploadGameTipsAsset(db, uploadRequest(image, { id, game: "Iceland" })), { status: 409 });
  await assert.rejects(uploadGameTipsAsset(db, uploadRequest(await png("#ff0000"), { id })), { status: 409 });

  const preview = gameTipsImagePreview(db, id);
  assert.equal(preview.headers.get("cache-control"), "private, no-store");
  assert.equal(preview.headers.get("content-type"), "image/jpeg");
  const saved = Buffer.from(await preview.arrayBuffer());
  assert.equal((await sharp(saved).metadata()).format, "jpeg");
  const edited = updateGameTipsAsset(db, { ...created.assets[0], game: "Dolphin Reef 2", enabled: false }, () => 30000);
  assert.equal(edited.assets[0].updatedAt, 30001);
  assert.deepEqual(edited.providers, []);
  assert.deepEqual(await uploadGameTipsAsset(db, uploadRequest(image, { id }), () => 55000), edited);
  assert.deepEqual(Buffer.from(await gameTipsImagePreview(db, id).arrayBuffer()), saved);
  assert.throws(() => updateGameTipsAsset(db, { ...created.assets[0], game: "Dolphin Reef 3" }), { status: 409 });
});

test("duplicate current game names normalize case, whitespace and full-width letters independently for each provider", async t => {
  const db = database(t), image = await png();
  const initial = await uploadGameTipsAsset(db, uploadRequest(image));
  await assert.rejects(uploadGameTipsAsset(db, uploadRequest(image, { provider: " ＭＥＧＡ８８８ ", game: "dolphin     reef" })), { status: 409 });
  await uploadGameTipsAsset(db, uploadRequest(image, { provider: "Other" }));
  const disabled = updateGameTipsAsset(db, { ...initial.assets[0], enabled: false });
  await uploadGameTipsAsset(db, uploadRequest(image, { provider: "mega888" }));
  assert.equal(listGameTipAssets(db, "ＭＥＧＡ８８８").length, 1);
  assert.deepEqual(gameTipsProviders(db), [{ name: "mega888", count: 1 }, { name: "Other", count: 1 }]);
  const disabledAsset = disabled.assets.find(asset => asset.id === initial.assets[0].id);
  assert.throws(() => updateGameTipsAsset(db, { ...disabledAsset, enabled: true }), { status: 409 });
});

test("invalid type, oversized body, fake image bytes and unsafe labels do not create an asset", async t => {
  const db = database(t), image = await png();
  const invalid = [
    [uploadRequest("<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"), 415],
    [uploadRequest(image, { contentType: "image/webp" }), 415],
    [uploadRequest(image, { length: 5_000_000 }), 413],
    [uploadRequest(Buffer.alloc(5_000_000)), 413],
    [uploadRequest(image, { game: "Bad\nLabel" }), 400],
    [uploadRequest(image, { provider: "p".repeat(49) }), 400],
    [uploadRequest(image, { game: "g".repeat(66) }), 400],
  ];
  for (const [request, status] of invalid) await assert.rejects(uploadGameTipsAsset(db, request), { status });
  assert.deepEqual(gameTipsLibrary(db), { assets: [], providers: [] });
});

test("poster uses the exact frozen ordered trio even after editing or disabling a library entry", async t => {
  const db = database(t);
  const input = [
    { game: "Dolphin Reef & Co <3", color: "#fb1919" },
    { game: "冰".repeat(65), color: "#19fb19" },
    { game: "G".repeat(65), color: "#1919fb" },
  ];
  for (const { game, color } of input) await uploadGameTipsAsset(db, uploadRequest(await png(color), { game }));
  const selection = {
    provider: "MEGA888",
    games: input.map(({ game }) => ({ id: listGameTipAssets(db).find(asset => asset.game === game).id, game })),
  };
  const before = await renderGameTips(db, selection);
  const asset = listGameTipAssets(db).find(asset => asset.id === selection.games[0].id);
  updateGameTipsAsset(db, { ...asset, game: "renamed later", provider: "Another Provider", enabled: false });
  assert.deepEqual(await renderGameTips(db, selection), before);

  const { data, info } = await sharp(before).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 1500);
  assert.equal(info.height, 900);
  assert.ok(before.byteLength < 10 * 1024 * 1024);
  for (const [index, x] of [275, 750, 1225].entries()) {
    const location = (x + 465 * info.width) * info.channels;
    const pixel = [...data.subarray(location, location + 3)];
    assert.ok(pixel[index] > 200 && pixel.filter(v => v < 60).length === 2, String(pixel));
  }
  await assert.rejects(gameTipsPosterPreview(db, "MEGA888"), { status: 400 });
  await uploadGameTipsAsset(db, uploadRequest(await png("#ffffff"), { game: "Great Blue" }));
  const preview = await gameTipsPosterPreview(db, "MEGA888");
  assert.equal(preview.headers.get("cache-control"), "private, no-store");
  assert.equal((await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).format, "jpeg");
});

test("first initialization within a discarded transaction can be safely repeated", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("BEGIN");
    assert.deepEqual(listGameTipAssets(db), []);
    db.exec("ROLLBACK");
    assert.deepEqual(listGameTipAssets(db), []);
  } finally { db.close(); }
});

test("enabled images delete immediately while queued snapshots stay intact until every delivery finishes", async t => {
  const db = database(t), id = randomUUID(), image = await png();
  await uploadGameTipsAsset(db, uploadRequest(image, { id }));
  await uploadGameTipsAsset(db, uploadRequest(await png("#0000ff"), { game: "Great Blue" }));
  await uploadGameTipsAsset(db, uploadRequest(await png("#00ff00"), { game: "Iceland" }));
  const games = listGameTipAssets(db);
  const asset = games.find(game => game.id === id);
  const selection = { provider: "MEGA888", games };
  const poster = await renderGameTips(db, selection);
  db.exec(`CREATE TABLE telegram_game_tip_slots(plan_id TEXT, plan_revision TEXT, run_at INTEGER, selection_json TEXT);
    CREATE TABLE telegram_scheduled_message_deliveries(plan_id TEXT, plan_revision TEXT, run_at INTEGER, status TEXT);
    INSERT INTO telegram_scheduled_message_deliveries VALUES ('a', 'b', 123, 'pending'), ('a', 'b', 123, 'sending');`);
  db.prepare("INSERT INTO telegram_game_tip_slots VALUES ('a', 'b', 123, ?)").run(JSON.stringify(selection));
  assert.throws(() => deleteGameTipsAsset(db, { ...asset, updatedAt: asset.updatedAt - 1 }), { status: 409 });
  const deleted = deleteGameTipsAsset(db, asset);
  assert.deepEqual(deleted, { assets: games.filter(game => game.id !== id), providers: [{ name: "MEGA888", count: 2 }] });
  assert.deepEqual(deleteGameTipsAsset(db, asset), deleted);
  assert.ok(!listGameTipAssets(db).some(game => game.id === id));
  assert.throws(() => gameTipsImagePreview(db, id), { status: 404 });
  assert.throws(() => updateGameTipsAsset(db, { ...asset, enabled: true }), { status: 404 });
  await assert.rejects(uploadGameTipsAsset(db, uploadRequest(image, { id })), { status: 409 });
  await uploadGameTipsAsset(db, uploadRequest(await png("#f0f0ff")));

  db.exec("UPDATE telegram_scheduled_message_deliveries SET status = 'sent' WHERE status = 'sending'");
  releaseDeletedGameTipsAssets(db);
  assert.deepEqual(await renderGameTips(db, selection), poster);
  db.exec("UPDATE telegram_scheduled_message_deliveries SET status = 'sent'");
  releaseDeletedGameTipsAssets(db);
  assert.equal(db.prepare("SELECT length(image) AS bytes FROM telegram_game_tips_assets WHERE id = ?").get(id).bytes, 0);
  await assert.rejects(renderGameTips(db, selection), { status: 404 });
});

test("an unqueued disabled asset can still be deleted and cleanup is a no-op on an unopened library", async t => {
  const db = database(t);
  releaseDeletedGameTipsAssets(db);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_schema").get().count, 0);
  const created = await uploadGameTipsAsset(db, uploadRequest(await png()));
  const disabled = updateGameTipsAsset(db, { ...created.assets[0], enabled: false });
  releaseDeletedGameTipsAssets(db);
  assert.deepEqual(deleteGameTipsAsset(db, disabled.assets[0]), { assets: [], providers: [] });
  assert.equal(db.prepare("SELECT length(image) AS bytes FROM telegram_game_tips_assets").get().bytes, 0);
});

test("counting actual image bytes allows more than 250 games in one platform", async t => {
  const db = database(t), image = await png();
  const initial = await uploadGameTipsAsset(db, uploadRequest(image));
  const duplicateBytes = db.prepare(`INSERT INTO telegram_game_tips_assets
    (id, provider, provider_key, game, game_key, enabled, image, upload_hash, created_at, updated_at)
    SELECT ?, provider, provider_key, ?, ?, enabled, image, upload_hash, created_at, updated_at
    FROM telegram_game_tips_assets WHERE id = ?`);
  for (let i = 1; i < 250; i++) duplicateBytes.run(randomUUID(), `Test ${i}`, `test ${i}`, initial.assets[0].id);
  const uploaded = await uploadGameTipsAsset(db, uploadRequest(image, { game: "Great Blue" }));
  assert.equal(uploaded.assets.length, 251);
  assert.deepEqual(uploaded.providers, [{ name: "MEGA888", count: 251 }]);
});

test("retained deleted bytes count toward library capacity until the terminal delivery permits reclamation", async t => {
  const db = new DatabaseSync(path.join(fixture, "image-capacity.sqlite")), id = randomUUID();
  t.after(() => db.close());
  const created = await uploadGameTipsAsset(db, uploadRequest(await png(), { id }));
  db.prepare("UPDATE telegram_game_tips_assets SET image = zeroblob(?) WHERE id = ?").run(128 * 1024 * 1024, id);
  db.exec(`CREATE TABLE telegram_game_tip_slots(plan_id TEXT, plan_revision TEXT, run_at INTEGER, selection_json TEXT);
    CREATE TABLE telegram_scheduled_message_deliveries(plan_id TEXT, plan_revision TEXT, run_at INTEGER, status TEXT);
    INSERT INTO telegram_scheduled_message_deliveries VALUES ('a', 'b', 123, 'pending');`);
  db.prepare("INSERT INTO telegram_game_tip_slots VALUES ('a', 'b', 123, ?)")
    .run(JSON.stringify({ provider: "MEGA888", games: [{ id, game: "Dolphin Reef" }] }));
  deleteGameTipsAsset(db, created.assets[0]);
  await assert.rejects(uploadGameTipsAsset(db, uploadRequest(await png())), { status: 507, message: /图库已达 128 MiB/ });
  assert.equal(gameTipsLibrary(db).assets.length, 0);
  db.exec("UPDATE telegram_scheduled_message_deliveries SET status = 'sent'");
  await uploadGameTipsAsset(db, uploadRequest(await png()));
  assert.equal(db.prepare("SELECT length(image) AS bytes FROM telegram_game_tips_assets WHERE id = ?").get(id).bytes, 0);
  assert.equal(listGameTipAssets(db).length, 1);
});

test("SQLite running out of pages reports insufficient storage and leaves the library usable", async t => {
  const db = database(t);
  await uploadGameTipsAsset(db, uploadRequest(await png()));
  const { page_count } = db.prepare("PRAGMA page_count").get();
  db.exec(`PRAGMA max_page_count = ${page_count}`);
  const width = 240, height = 160, channels = 3;
  const texture = await sharp(randomBytes(width * height * channels), { raw: { width, height, channels } }).png().toBuffer();
  await assert.rejects(uploadGameTipsAsset(db, uploadRequest(texture, { game: "Great Blue" })), {
    status: 507, message: /服务器剩余储存空间不足/,
  });
  assert.equal(db.isTransaction, false);
  assert.equal(listGameTipAssets(db).length, 1);
  db.exec(`PRAGMA max_page_count = ${page_count + 100}`);
  await uploadGameTipsAsset(db, uploadRequest(texture, { game: "Great Blue" }));
  assert.equal(listGameTipAssets(db).length, 2);
});

test("logo-first providers show with no games, preserve canonical naming and expose only the current transparent WebP", async t => {
  const db = database(t), id = randomUUID(), second = randomUUID();
  const image = await sharp({ create: { width: 512, height: 280, channels: 4, background: "#ff000063" } }).png().toBuffer();
  const first = await uploadGameTipsLogo(db, logoRequest(image, { id }));
  assert.deepEqual(first, { assets: [], providers: [{ name: "MEGA888", count: 0, logoId: id }] });
  assert.deepEqual(await uploadGameTipsLogo(db, logoRequest(image, { id })), first);
  assert.deepEqual(gameTipsProviderLogo(db, "ｍｅｇａ888"), { name: "MEGA888", logoId: id });
  const preview = gameTipsLogoPreview(db, id);
  assert.equal(preview.headers.get("content-type"), "image/webp");
  assert.equal(preview.headers.get("cache-control"), "private, no-store");
  const previewData = Buffer.from(await preview.arrayBuffer());
  const { format, width, height, hasAlpha } = await sharp(previewData).metadata();
  assert.equal(format, "webp");
  assert.ok(width <= 360 && height <= 220 && hasAlpha);
  assert.ok(previewData.byteLength <= 96 * 1024);
  const next = await png("#19fb19");
  await assert.rejects(uploadGameTipsLogo(db, logoRequest(next, { id })), { status: 409 });
  await assert.rejects(uploadGameTipsLogo(db, logoRequest(next, { id: second })), { status: 409 });
  await assert.rejects(uploadGameTipsLogo(db, logoRequest(next, { id: second, previousId: id, contentType: "image/jpeg" })), { status: 415 });
  await uploadGameTipsAsset(db, uploadRequest(next, { provider: "mega888" }));
  const replaced = await uploadGameTipsLogo(db, logoRequest(next, { id: second, previousId: id, provider: " mega888 " }));
  assert.deepEqual(replaced.providers, [{ name: "MEGA888", count: 1, logoId: second }]);
  assert.throws(() => gameTipsLogoPreview(db, id), { status: 404 });
  assert.deepEqual(await uploadGameTipsLogo(db, logoRequest(image, { id })), replaced);
  assert.equal(db.prepare("SELECT length(image) AS bytes FROM telegram_game_tips_logos WHERE id = ?").get(id).bytes, 0);
});

test("name-only edits preserve the logo and move all existing games, with normalized collision and stale editor checks", async t => {
  const db = database(t), logoId = randomUUID(), image = await png();
  await uploadGameTipsLogo(db, logoRequest(image, { id: logoId }));
  await uploadGameTipsLogo(db, logoRequest(image, { provider: "Other" }));
  const active = (await uploadGameTipsAsset(db, uploadRequest(image), () => 30_000)).assets[0];
  const disabled = (await uploadGameTipsAsset(db, uploadRequest(image, { game: "Iceland", provider: "mega888" }), () => 31_000))
    .assets.find(asset => asset.game === "Iceland");
  updateGameTipsAsset(db, { ...disabled, enabled: false }, () => 32_000);
  const before = gameTipsLibrary(db);
  assert.throws(() => updateGameTipsPlatform(db, { provider: "MEGA888", name: "ＯＴＨＥＲ", previousId: logoId }), { status: 409 });
  assert.throws(() => updateGameTipsPlatform(db, { provider: "MEGA888", name: "Mega Game", previousId: randomUUID() }), { status: 409 });
  assert.deepEqual(gameTipsLibrary(db), before);

  const casing = updateGameTipsPlatform(db, { provider: "MEGA888", name: "Mega888", previousId: logoId }, () => 32_000);
  assert.equal(casing.providers.find(value => value.logoId === logoId).name, "Mega888");
  const result = updateGameTipsPlatform(db, { provider: "Mega888", name: "Mega Game", previousId: logoId }, () => 33_000);
  assert.deepEqual(result.providers.map(({ name, count }) => ({ name, count })), [{ name: "Mega Game", count: 1 }, { name: "Other", count: 0 }]);
  assert.deepEqual(gameTipsProviderLogo(db, "Mega Game"), { name: "Mega Game", logoId });
  assert.deepEqual(result.assets.map(asset => [asset.provider, asset.enabled]), [["Mega Game", true], ["Mega Game", false]]);
  assert.equal(gameTipsLogoPreview(db, logoId).status, 200);
  assert.equal(gameTipsImagePreview(db, active.id).status, 200);
  assert.throws(() => updateGameTipsAsset(db, { ...active, game: "stale editor" }), { status: 409 });
});

test("removing a logo leaves a logo-only platform visible and rejects a stale replacement", async t => {
  const db = database(t), logoId = randomUUID(), image = await png();
  await uploadGameTipsLogo(db, logoRequest(image, { id: logoId }));
  const remove = { provider: "MEGA888", previousId: logoId, action: "removeLogo" };
  assert.throws(() => removeGameTipsPlatformPart(db, { ...remove, previousId: randomUUID() }), { status: 409 });
  const result = removeGameTipsPlatformPart(db, remove);
  assert.deepEqual(result.assets, []);
  assert.equal(result.providers.length, 1);
  assert.equal(result.providers[0].name, "MEGA888");
  assert.equal(result.providers[0].count, 0);
  assert.equal(result.providers[0].logoId, undefined);
  assert.throws(() => gameTipsLogoPreview(db, logoId), { status: 404 });
  await assert.rejects(uploadGameTipsLogo(db, logoRequest(image, { previousProvider: "MEGA888", previousId: logoId })), { status: 409 });
  await uploadGameTipsLogo(db, logoRequest(image, { previousProvider: "MEGA888" }));
  assert.ok(gameTipsProviderLogo(db, "MEGA888"));
});

test("explicit platform deletion hides all current media and stale requests cannot recreate it", async t => {
  const db = database(t), logoId = randomUUID(), backgroundId = randomUUID(), id = randomUUID(), image = await png();
  await uploadGameTipsLogo(db, logoRequest(image, { id: logoId }));
  await uploadGameTipsBackground(db, backgroundRequest(image, { id: backgroundId }));
  await uploadGameTipsAsset(db, uploadRequest(image, { id }));
  const deleted = removeGameTipsPlatformPart(db, { provider: "MEGA888", previousId: logoId, action: "deletePlatform" });
  assert.deepEqual(deleted, { assets: [], providers: [] });
  for (const [read, mediaId] of [[gameTipsImagePreview, id], [gameTipsLogoPreview, logoId], [gameTipsBackgroundPreview, backgroundId]]) {
    assert.throws(() => read(db, mediaId), { status: 404 });
  }
  await assert.rejects(uploadGameTipsAsset(db, uploadRequest(image, { game: "Late upload" })), { status: 409 });
  await assert.rejects(uploadGameTipsLogo(db, logoRequest(image, { previousProvider: "MEGA888", previousId: logoId })), { status: 404 });
  await assert.rejects(uploadGameTipsBackground(db, backgroundRequest(image, { previousId: backgroundId })), error => [404, 409].includes(error.status));
  assert.deepEqual(gameTipsLibrary(db), deleted);
  const revived = await uploadGameTipsLogo(db, logoRequest(image));
  assert.equal(revived.providers[0].name, "MEGA888");
  assert.equal(revived.providers[0].count, 0);
  assert.equal(revived.providers[0].backgroundId, undefined);
  assert.deepEqual(revived.assets, []);
});

test("combined rename and logo replacement safely replay the same operation after the original name is retired", async t => {
  const db = database(t), previousId = randomUUID(), id = randomUUID(), image = await png("#19fb19");
  await uploadGameTipsLogo(db, logoRequest(await png(), { id: previousId }));
  await uploadGameTipsAsset(db, uploadRequest(image));
  const replacement = { id, provider: "Mega Picks", previousProvider: "MEGA888", previousId };
  const saved = await uploadGameTipsLogo(db, logoRequest(image, replacement));
  assert.equal(saved.providers.length, 1);
  assert.deepEqual(gameTipsProviderLogo(db, "Mega Picks"), { name: "Mega Picks", logoId: id });
  assert.equal(saved.assets[0].provider, "Mega Picks");
  assert.deepEqual(await uploadGameTipsLogo(db, logoRequest(image, replacement)), saved);
  await assert.rejects(uploadGameTipsLogo(db, logoRequest(image, { ...replacement, provider: "Other" })), { status: 409 });
  assert.throws(() => gameTipsLogoPreview(db, previousId), { status: 404 });
  assert.equal(gameTipsLogoPreview(db, id).status, 200);
});

test("replacing a logo keeps queued poster output identical and reclaims prior bytes once the queue is terminal", async t => {
  const db = database(t), id = randomUUID(), second = randomUUID();
  await uploadGameTipsLogo(db, logoRequest(await png("#fb1919"), { id }));
  for (const game of ["Dolphin Reef", "Iceland", "Great Blue"]) {
    await uploadGameTipsAsset(db, uploadRequest(await png("#1919fb"), { game, provider: "mega888" }));
  }
  const games = listGameTipAssets(db), selection = { provider: "MEGA888", games, logoId: id };
  db.exec(`CREATE TABLE telegram_game_tip_slots(plan_id TEXT, plan_revision TEXT, run_at INTEGER, provider_key TEXT, selection_json TEXT);
    CREATE TABLE telegram_scheduled_message_deliveries(plan_id TEXT, plan_revision TEXT, run_at INTEGER, status TEXT);
    INSERT INTO telegram_scheduled_message_deliveries VALUES ('a', 'b', 123, 'pending');`);
  db.prepare("INSERT INTO telegram_game_tip_slots VALUES ('a', 'b', 123, 'mega888', ?)").run(JSON.stringify(selection));
  const before = await renderGameTips(db, selection);
  await uploadGameTipsLogo(db, logoRequest(await png("#19fb19"), { id: second, previousId: id }));
  assert.throws(() => gameTipsLogoPreview(db, id), { status: 404 });
  assert.deepEqual(await renderGameTips(db, selection), before);
  const { data: firstPoster, info } = await sharp(before).raw().toBuffer({ resolveWithObject: true });
  const preview = await gameTipsPosterPreview(db, "mega888");
  const secondPoster = await sharp(Buffer.from(await preview.arrayBuffer())).raw().toBuffer();
  const position = (1180 + 87 * info.width) * info.channels;
  assert.ok(firstPoster[position] > 200 && firstPoster[position + 1] < 60);
  assert.ok(secondPoster[position + 1] > 200 && secondPoster[position] < 60);

  db.exec("UPDATE telegram_scheduled_message_deliveries SET status = 'sent'");
  await uploadGameTipsLogo(db, logoRequest(await png("#19fb19"), { provider: "Other" }));
  assert.equal(db.prepare("SELECT length(image) AS bytes FROM telegram_game_tips_logos WHERE id = ?").get(id).bytes, 0);
});

test("renaming a platform retains pinned logo and template versions across subsequent replacement", async t => {
  const db = database(t), logoId = randomUUID(), backgroundId = randomUUID(), gameImage = await png("#1919fb");
  await uploadGameTipsLogo(db, logoRequest(await png("#fb1919"), { id: logoId }));
  await uploadGameTipsBackground(db, backgroundRequest(await png("#281457"), { id: backgroundId }));
  for (const game of ["Dolphin Reef", "Iceland", "Great Blue"]) await uploadGameTipsAsset(db, uploadRequest(gameImage, { game }));
  const games = listGameTipAssets(db), logoSlot = { provider: "MEGA888", games, logoId };
  const backgroundSlot = { ...logoSlot, backgroundId };
  db.exec(`CREATE TABLE telegram_game_tip_slots(plan_id TEXT, plan_revision TEXT, run_at INTEGER, provider_key TEXT, selection_json TEXT);
    CREATE TABLE telegram_scheduled_message_deliveries(plan_id TEXT, plan_revision TEXT, run_at INTEGER, status TEXT);
    INSERT INTO telegram_scheduled_message_deliveries VALUES ('a', 'b', 123, 'pending'), ('a', 'b', 456, 'sending');`);
  const saveSlot = db.prepare("INSERT INTO telegram_game_tip_slots VALUES ('a', 'b', ?, 'mega888', ?)");
  saveSlot.run(123, JSON.stringify(logoSlot));
  saveSlot.run(456, JSON.stringify(backgroundSlot));
  const oldLogo = await renderGameTips(db, logoSlot);
  const oldBackground = await renderGameTips(db, backgroundSlot);
  const newerLogo = randomUUID();
  // Already retired but still pending at rename time.
  await uploadGameTipsLogo(db, logoRequest(await png("#19fb19"), { id: newerLogo, previousId: logoId }));
  updateGameTipsPlatform(db, { provider: "MEGA888", name: "Mega Game", previousId: newerLogo });
  await uploadGameTipsLogo(db, logoRequest(await png("#1919fb"), { provider: "Mega Game", previousProvider: "Mega Game", previousId: newerLogo }));
  await uploadGameTipsBackground(db, backgroundRequest(await png("#bc7632"), { provider: "Mega Game", previousId: backgroundId }));
  assert.deepEqual(await renderGameTips(db, logoSlot), oldLogo);
  assert.deepEqual(await renderGameTips(db, backgroundSlot), oldBackground);
  assert.deepEqual(db.prepare("SELECT selection_json FROM telegram_game_tip_slots ORDER BY run_at").all().map(row => JSON.parse(row.selection_json)),
    [logoSlot, backgroundSlot]);
});

test("backgrounds require a known platform, validate 3 nonoverlapping positions and update geometry without decoding again", async t => {
  const db = database(t), id = randomUUID(), second = randomUUID(), image = await png("#241965");
  await assert.rejects(uploadGameTipsBackground(db, backgroundRequest(image, { id })), { status: 404 });
  await uploadGameTipsLogo(db, logoRequest(await png()));
  const slots = GAME_TIPS_DEFAULT_SLOTS.map(box => ({ ...box, y: 58 }));
  for (const position of [
    GAME_TIPS_DEFAULT_SLOTS.slice(0, 2),
    slots.map((slot, index) => index === 0 ? { ...slot, width: 4.99 } : slot),
    slots.map((slot, index) => index === 0 ? { ...slot, x: 100 } : slot),
    slots.map((slot, index) => index === 1 ? { ...slot, x: 20 } : slot),
    slots.map((slot, index) => index === 1 ? { ...slot, y: "59" } : slot),
  ]) {
    assert.equal(validGameTipsBackgroundSlots(position), false);
    await assert.rejects(uploadGameTipsBackground(db, backgroundRequest(image, { id, slots: position })), { status: 400 });
  }
  assert.equal(validGameTipsBackgroundSlots(slots), true);
  const first = await uploadGameTipsBackground(db, backgroundRequest(image, { id }));
  assert.deepEqual(await uploadGameTipsBackground(db, backgroundRequest(image, { id })), first);
  assert.deepEqual(first.providers[0].backgroundSlots, GAME_TIPS_DEFAULT_SLOTS);
  assert.equal(gameTipsProviderBackgroundId(db, "ｍｅｇａ888"), id);
  const before = gameTipsBackgroundPreview(db, id);
  assert.equal(before.headers.get("content-type"), "image/webp");
  assert.equal(before.headers.get("cache-control"), "private, no-store");
  const geometry = { id: second, provider: "mega888", previousId: id, slots };
  const update = updateGameTipsBackgroundSlots(db, geometry);
  assert.deepEqual(updateGameTipsBackgroundSlots(db, geometry), update);
  assert.throws(() => updateGameTipsBackgroundSlots(db, { ...geometry, id: randomUUID() }), { status: 409 });
  assert.deepEqual(update.providers[0].backgroundSlots, slots);
  assert.throws(() => gameTipsBackgroundPreview(db, id), { status: 404 });
  assert.deepEqual(await gameTipsBackgroundPreview(db, second).arrayBuffer(), await before.arrayBuffer());
});

test("template poster keeps background art and uses exact slot images with no added name text while preserving queued artwork", async t => {
  const db = database(t), id = randomUUID(), second = randomUUID();
  for (const [name, color] of [["R", "#fb1919"], ["G", "#19fb19"], ["B", "#1919fb"]]) {
    await uploadGameTipsAsset(db, uploadRequest(await png(color), { game: name }));
  }
  const background = await sharp({ create: { width: 1586, height: 992, channels: 3, background: "#281457" } }).png().toBuffer();
  await uploadGameTipsBackground(db, backgroundRequest(background, { id }));
  const assets = listGameTipAssets(db), games = ["R", "G", "B"].map(game => assets.find(asset => asset.game === game));
  const selection = { provider: "MEGA888", games, backgroundId: id };
  db.exec(`CREATE TABLE telegram_game_tip_slots(plan_id TEXT, plan_revision TEXT, run_at INTEGER, provider_key TEXT, selection_json TEXT);
    CREATE TABLE telegram_scheduled_message_deliveries(plan_id TEXT, plan_revision TEXT, run_at INTEGER, status TEXT);
    INSERT INTO telegram_scheduled_message_deliveries VALUES ('a', 'b', 123, 'sending');`);
  db.prepare("INSERT INTO telegram_game_tip_slots VALUES ('a', 'b', 123, 'mega888', ?)").run(JSON.stringify(selection));
  const before = await renderGameTips(db, selection);
  assert.deepEqual(await renderGameTips(db, { ...selection, games: games.map(game => ({ ...game, game: "No text overlay" })) }), before);
  const { data, info } = await sharp(before).raw().toBuffer({ resolveWithObject: true });
  assert.equal(info.width, 1586);
  assert.equal(info.height, 992);
  const getPixel = (x, y) => [...data.subarray((x + y * info.width) * info.channels, (x + y * info.width) * info.channels + 3)];
  assert.ok(getPixel(793, 170).every((value, index) => Math.abs(value - [40, 20, 87][index]) < 12));
  for (const [index, slot] of GAME_TIPS_DEFAULT_SLOTS.entries()) {
    const x = Math.round(info.width * (slot.x + slot.width / 2) / 100);
    const y = Math.round(info.height * (slot.y + slot.height / 2) / 100);
    const pixel = getPixel(x, y);
    assert.ok(pixel[index] > 200 && pixel.filter(value => value < 60).length === 2, String(pixel));
  }
  const preview = await gameTipsPosterPreview(db, "MEGA888");
  assert.equal((await sharp(Buffer.from(await preview.arrayBuffer())).metadata()).width, 1586);
  await uploadGameTipsBackground(db, backgroundRequest(await png("#bc7632"), { id: second, previousId: id }));
  assert.throws(() => gameTipsBackgroundPreview(db, id), { status: 404 });
  assert.deepEqual(await renderGameTips(db, selection), before);
  db.exec("UPDATE telegram_scheduled_message_deliveries SET status = 'sent'");
  updateGameTipsBackgroundSlots(db, { id: randomUUID(), provider: "MEGA888", previousId: second, slots: GAME_TIPS_DEFAULT_SLOTS });
  assert.equal(db.prepare("SELECT length(image) AS bytes FROM telegram_game_tips_backgrounds WHERE id = ?").get(id).bytes, 0);
});
