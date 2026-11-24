import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
const { deleteGameTipsAsset, gameTipsCaption, gameTipsImagePreview, gameTipsLibrary, gameTipsPosterPreview, gameTipsProviders, listGameTipAssets,
  renderGameTips, updateGameTipsAsset, uploadGameTipsAsset } = require(path.join(fixture, "telegram-game-tips.js"));

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

test("poster uses the exact frozen ordered trio and caption even after editing or disabling a library entry", async t => {
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

  const caption = gameTipsCaption(selection);
  assert.match(caption, /^Game Tips🔥\n\n365FreeBonus X MEGA888\n\n/);
  assert.ok(caption.includes(input.map(({ game }) => game).join("\n")));
  assert.ok(caption.endsWith("https://365freebonus.com"));
  assert.ok(caption.length < 1024);
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

test("enabled and queued images cannot be deleted and a retired ID cannot be resurrected", async t => {
  const db = database(t), id = randomUUID(), image = await png();
  const created = await uploadGameTipsAsset(db, uploadRequest(image, { id }));
  assert.throws(() => deleteGameTipsAsset(db, created.assets[0]), { status: 409 });
  const disabled = updateGameTipsAsset(db, { ...created.assets[0], enabled: false });
  db.exec(`CREATE TABLE telegram_game_tip_slots(plan_id TEXT, plan_revision TEXT, run_at INTEGER, selection_json TEXT);
    CREATE TABLE telegram_scheduled_message_deliveries(plan_id TEXT, plan_revision TEXT, run_at INTEGER, status TEXT);
    INSERT INTO telegram_scheduled_message_deliveries VALUES ('a', 'b', 123, 'pending');`);
  db.prepare("INSERT INTO telegram_game_tip_slots VALUES ('a', 'b', 123, ?)")
    .run(JSON.stringify({ provider: "MEGA888", games: [{ id, game: "Dolphin Reef" }] }));
  assert.throws(() => deleteGameTipsAsset(db, disabled.assets[0]), { status: 409 });
  db.exec("UPDATE telegram_scheduled_message_deliveries SET status = 'sent'");
  assert.deepEqual(deleteGameTipsAsset(db, disabled.assets[0]), { assets: [], providers: [] });
  assert.throws(() => gameTipsImagePreview(db, id), { status: 404 });
  await assert.rejects(uploadGameTipsAsset(db, uploadRequest(image, { id })), { status: 409 });
});
