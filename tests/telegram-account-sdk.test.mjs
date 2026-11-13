import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { Api, TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions';
import { RPCMessageToError } from 'teleproto/errors';

// Real client construction, auth.sendCode and SDK retry/migration logic. Only
// the sender transport is replaced, so these tests never open a socket or ask
// Telegram to send a code to a real account.
const fixture = mkdtempSync(path.join(tmpdir(), 'telegram-account-real-sdk-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), path.join(fixture, 'node_modules'), 'dir');
for (const name of ['sqlite', 'telegram-account']) {
  writeFileSync(path.join(fixture, `${name}.js`), ts.transpileModule(
    readFileSync(new URL(`../app/lib/${name}.ts`, import.meta.url), 'utf8'),
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } },
  ).outputText);
}
const require = createRequire(import.meta.url);
const { createTelegramAccountClient } = require(path.join(fixture, 'telegram-account.js'));
const credentials = { apiId: 1, apiHash: '0'.repeat(32) };
const phone = '+60123456789';
const sentCode = () => new Api.auth.SentCode({
  type: new Api.auth.SentCodeTypeApp({ length: 5 }), phoneCodeHash: 'fixture-code-hash',
});
test.after(() => rmSync(fixture, { recursive: true, force: true }));

function errorFor(request, errorMessage, errorCode) {
  return RPCMessageToError({ errorMessage, errorCode }, request);
}

async function withClient(work) {
  assert.equal(typeof createTelegramAccountClient, 'function');
  const client = createTelegramAccountClient(credentials, '');
  const requests = [];
  const migrations = [];
  let result;
  let reply = () => sentCode();
  client.connect = async () => { throw new Error('Unexpected network connection in SDK regression.'); };
  client._connectedDeferred.resolve();
  client._switchDC = async dcId => { migrations.push(dcId); };
  client._sender = {
    userDisconnected: false,
    addStateToQueue(state) {
      requests.push(state.request.className);
      queueMicrotask(() => {
        try {
          if (state.request instanceof Api.updates.GetState) throw errorFor(state.request, 'AUTH_KEY_UNREGISTERED', 401);
          state.resolve(reply(state.request));
        } catch (error) { state.reject(error); }
      });
    },
  };
  try {
    result = await work({ client, requests, migrations, setReply: value => { reply = value; } });
  } finally {
    client._sender = undefined;
    await client.destroy();
  }
  return result;
}

test('personal-account factory constructs the actual SDK with a production StringSession and recovery budget', async () => {
  await withClient(({ client }) => {
    assert.ok(client instanceof TelegramClient);
    assert.ok(client.session instanceof StringSession);
    assert.equal(client.session.testServers, false);
    assert.ok(client._requestRetries >= 2 && client._requestRetries <= 5, 'a DC migration needs a subsequent RPC attempt');
    assert.equal(client.floodSleepThreshold, 0);
    assert.equal(client._autoReconnect, false);
  });
});

test('real auth.sendCode follows a phone DC migration and then returns the code challenge', async () => {
  await withClient(async ({ client, requests, migrations, setReply }) => {
    let attempts = 0;
    setReply(request => {
      assert.ok(request instanceof Api.auth.SendCode);
      if (++attempts === 1) throw errorFor(request, 'PHONE_MIGRATE_4', 303);
      return sentCode();
    });
    const result = await client.sendCode(credentials, phone);
    assert.equal(result.phoneCodeHash, 'fixture-code-hash');
    assert.equal(result.isCodeViaApp, true);
    assert.deepEqual(migrations, [4]);
    assert.equal(requests.filter(name => name === 'auth.SendCode').length, 2);
    assert.equal(requests.filter(name => name === 'updates.GetState').length, 1);
  });
});

test('real SDK surfaces Telegram FloodWait without silently sleeping or sending another code request', async () => {
  await withClient(async ({ client, requests, migrations, setReply }) => {
    setReply(request => { throw errorFor(request, 'FLOOD_WAIT_120', 420); });
    await assert.rejects(client.sendCode(credentials, phone), error => error.errorMessage === 'FLOOD_WAIT_120' && error.seconds === 120);
    assert.equal(requests.filter(name => name === 'auth.SendCode').length, 1);
    assert.deepEqual(migrations, []);
  });
});

test('real SDK does not retry an invalid application credential response', async () => {
  await withClient(async ({ client, requests, migrations, setReply }) => {
    setReply(request => { throw errorFor(request, 'API_ID_INVALID', 400); });
    await assert.rejects(client.sendCode(credentials, phone), error => error.errorMessage === 'API_ID_INVALID');
    assert.equal(requests.filter(name => name === 'auth.SendCode').length, 1);
    assert.deepEqual(migrations, []);
  });
});
