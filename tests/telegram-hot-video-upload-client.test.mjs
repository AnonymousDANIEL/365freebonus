import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const fixture = mkdtempSync(path.join(tmpdir(), 'telegram-hot-upload-client-'));
writeFileSync(path.join(fixture, 'package.json'), '{"type":"commonjs"}');
mkdirSync(path.join(fixture,'lib'));
writeFileSync(path.join(fixture,'lib/telegram-hot-video-limits.js'),ts.transpileModule(readFileSync(new URL('../app/lib/telegram-hot-video-limits.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText);
writeFileSync(path.join(fixture, 'client.js'), ts.transpileModule(
  readFileSync(new URL('../app/[adminPath]/hot-video-upload-client.ts', import.meta.url), 'utf8').replace('../lib/telegram-hot-video-limits','./lib/telegram-hot-video-limits'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText);
const require = createRequire(import.meta.url);
const { uploadHotVideoFile, getHotVideoUploadResumes, HotVideoUploadError,
  xhrHotVideoUploadRequest, cancelHotVideoUpload } = require(path.join(fixture, 'client.js'));
test.after(() => rmSync(fixture, { recursive: true, force: true }));

const CHUNK = 1024 * 1024;
const ENDPOINT = '/api/admin/telegram/hot-videos/uploads';
const STORAGE_KEY = '365freebonus:hot-video-uploads:v1';
const ID = '11111111-1111-4111-8111-111111111111';
const NEXT_ID = '22222222-2222-4222-8222-222222222222';

class MapStorage {
  values = new Map();
  getItem(key) { return this.values.get(key) ?? null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  removeItem(key) { this.values.delete(key); }
}

function localFile(size = CHUNK + 48, { name = 'private.mp4', lastModified = 1770000000000, failRead } = {}) {
  const data = Buffer.alloc(size, 0x6d), reads = [];
  // Distinguish consecutive chunks and their edges when checking a retry.
  for (let offset = 0; offset < size; offset += CHUNK) data[offset] = offset / CHUNK % 251;
  return { name, lastModified, size, data, reads,
    slice(start, end) {
      return { async arrayBuffer() {
        reads.push({ start, end });
        if (failRead?.({ start, end, read: reads.length })) throw new Error('local file disappeared');
        return data.buffer.slice(data.byteOffset + start, data.byteOffset + end);
      } };
    },
  };
}

function saved(file, overrides = {}) {
  return { id: ID, requestId: ID, bytes: file.size, receivedBytes: 0, chunkBytes: CHUNK,
    state: 'uploading', expiresAt: Date.now() + 600000, videoId: null,
    originalName: file.name, lastModified: file.lastModified, title: 'Original title', ...overrides };
}
function seed(storage, file, overrides) { storage.setItem(STORAGE_KEY, JSON.stringify([saved(file, overrides)])); }
function network() { return new HotVideoUploadError('lost upload reply', 0, 'network'); }
function isError(kind, status) {
  return error => error instanceof HotVideoUploadError && error.kind === kind && (status === undefined || error.status === status);
}

// A stateful, in-memory HTTP peer. It never creates a socket or uses real APIs.
// Fault hooks can drop a reply before or after reply() commits the request.
function server(file, hook) {
  const requests = [], sessions = new Map();
  let registrations = 0;
  const snapshot = value => ({ ...value });
  const reply = request => {
    const { method, path: url } = request;
    if (method === 'POST' && url === ENDPOINT) {
      const input = request.json;
      if (!sessions.has(input.requestId)) sessions.set(input.requestId, {
        id: input.requestId, requestId: input.requestId, bytes: input.bytes, receivedBytes: 0,
        chunkBytes: CHUNK, state: 'uploading', expiresAt: Date.now() + 600000, videoId: null,
      });
      return { status: 200, body: snapshot(sessions.get(input.requestId)) };
    }
    assert.ok(url.startsWith(ENDPOINT + '/'), 'only the private upload API is used');
    const suffix = url.slice(ENDPOINT.length + 1), [id, operation] = suffix.split('/');
    const current = sessions.get(id);
    if (method === 'DELETE') { sessions.delete(id); return { status: 200, body: {} }; }
    if (!current) return { status: 404, body: { error: 'missing upload' } };
    if (method === 'GET') return { status: 200, body: snapshot(current) };
    if (method === 'PUT') {
      assert.ok(request.body instanceof ArrayBuffer);
      assert.ok(!(request.body instanceof Blob), 'disk File/Blob objects must not reach transport');
      assert.ok(request.body.byteLength > 0 && request.body.byteLength <= CHUNK);
      const offset = Number(request.headers?.['X-Video-Offset']);
      assert.equal(offset, current.receivedBytes, 'a committed chunk must not be appended twice');
      assert.deepEqual(Buffer.from(request.body), file.data.subarray(offset, offset + request.body.byteLength));
      current.receivedBytes += request.body.byteLength;
      return { status: 200, body: snapshot(current) };
    }
    assert.equal(method, 'POST'); assert.equal(operation, 'complete');
    assert.deepEqual(request.json, {}); assert.equal(current.receivedBytes, file.size);
    if (current.state !== 'complete') registrations++;
    current.state = 'complete'; current.videoId = id;
    return { status: 200, body: { videos: [] } };
  };
  const api = { requests, sessions, reply, get registrations() { return registrations; } };
  api.transport = async request => { requests.push(request); return hook ? await hook(request, api) : reply(request); };
  return api;
}
function settings(file, api, extra = {}) {
  const storage = extra.storage ?? new MapStorage(), delays = [];
  return { file, title: '  Original title  ', transport: api.transport, storage, newId: () => ID,
    sleep: async ms => { delays.push(ms); }, delays, ...extra };
}
const puts = api => api.requests.filter(request => request.method === 'PUT');
const gets = api => api.requests.filter(request => request.method === 'GET');
const completes = api => api.requests.filter(request => request.path.endsWith('/complete'));

test('60 MiB exceeds the old cap and uses sixty exact one MiB ArrayBuffers, private offsets, and a separate idempotent completion', async () => {
  const file = localFile(60 * CHUNK), api = server(file), progress = [];
  const options = settings(file, api, { onProgress: value => progress.push(value) });
  assert.deepEqual(await uploadHotVideoFile(options), { videos: [] });
  assert.deepEqual(api.requests[0].json, { requestId: ID, title: 'Original title', originalName: file.name, bytes: file.size });
  assert.equal(api.requests[0].method, 'POST'); assert.equal(api.requests[0].path, ENDPOINT);
  assert.equal(puts(api).length, 60); assert.equal(gets(api).length, 0); assert.equal(completes(api).length, 1);
  assert.deepEqual(puts(api).map(request => Number(request.headers['X-Video-Offset'])), Array.from({ length: 60 }, (_, index) => index * CHUNK));
  assert.ok(puts(api).every(request => request.body instanceof ArrayBuffer && request.body.byteLength === CHUNK));
  assert.deepEqual(file.reads[0], { start: 0, end: 64 }); assert.equal(file.reads.length, 61);
  assert.equal(progress.at(-1).phase, 'verifying'); assert.equal(progress.at(-1).acknowledgedBytes, file.size);
  assert.deepEqual(getHotVideoUploadResumes(options.storage), []); assert.deepEqual(options.delays, []);
});

test('failure reading the first 64 local bytes makes no API request or pending resume', async () => {
  const file = localFile(48, { failRead: () => true }), api = server(file), options = settings(file, api);
  await assert.rejects(uploadHotVideoFile(options), isError('file_read', 0));
  assert.deepEqual(file.reads, [{ start: 0, end: 48 }]); assert.equal(api.requests.length, 0);
  assert.deepEqual(getHotVideoUploadResumes(options.storage), []); assert.deepEqual(options.delays, []);
});

test('a later disk read failure keeps acknowledged progress and is never retried as a network outage', async () => {
  const file = localFile(2 * CHUNK, { failRead: ({ start }) => start >= CHUNK }), api = server(file), options = settings(file, api);
  await assert.rejects(uploadHotVideoFile(options), isError('file_read', 0));
  assert.equal(puts(api).length, 1); assert.equal(gets(api).length, 0); assert.equal(completes(api).length, 0);
  assert.equal(getHotVideoUploadResumes(options.storage)[0].receivedBytes, CHUNK); assert.deepEqual(options.delays, []);
});

test('a network status-zero failure before commit reads server progress then retries identical bytes', async () => {
  const file = localFile(CHUNK + 48); let dropped = false;
  const api = server(file, (request, peer) => {
    if (request.method === 'PUT' && !dropped) { dropped = true; throw network(); }
    return peer.reply(request);
  });
  const options = settings(file, api);
  await uploadHotVideoFile(options);
  assert.deepEqual(api.requests.slice(0, 5).map(request => request.method), ['POST', 'PUT', 'GET', 'PUT', 'PUT']);
  assert.equal(puts(api)[0].headers['X-Video-Offset'], '0'); assert.equal(puts(api)[1].headers['X-Video-Offset'], '0');
  assert.deepEqual(Buffer.from(puts(api)[0].body), Buffer.from(puts(api)[1].body));
  assert.deepEqual(options.delays, [1000]); assert.equal(api.registrations, 1);
});

test('a lost chunk reply after commit advances from GET without appending the same bytes again', async () => {
  const file = localFile(CHUNK + 48); let dropped = false;
  const api = server(file, (request, peer) => {
    const response = peer.reply(request);
    if (request.method === 'PUT' && !dropped) { dropped = true; throw network(); }
    return response;
  });
  await uploadHotVideoFile(settings(file, api));
  assert.deepEqual(puts(api).map(request => request.headers['X-Video-Offset']), ['0', String(CHUNK)]);
  assert.equal(gets(api).length, 1); assert.equal(api.registrations, 1);
});

test('the final permitted lost PUT reply still reconciles a committed chunk before giving up', async () => {
  const file = localFile(48); let attempts = 0;
  const api = server(file, (request, peer) => {
    if (request.method === 'PUT') { if (++attempts === 3) peer.reply(request); throw network(); }
    return peer.reply(request);
  });
  const options = settings(file, api);
  assert.deepEqual(await uploadHotVideoFile(options), { videos: [] });
  assert.equal(puts(api).length, 3); assert.equal(gets(api).length, 3); assert.equal(api.registrations, 1);
  assert.deepEqual(options.delays, [1000, 2000]);
});

test('a later invocation with the same file metadata resumes by GET and retains the original title and UUID', async () => {
  const file = localFile(CHUNK + 48); let offline = true;
  const api = server(file, (request, peer) => {
    if (offline && request.method === 'PUT' && request.headers['X-Video-Offset'] === String(CHUNK)) throw network();
    return peer.reply(request);
  });
  const options = settings(file, api);
  await assert.rejects(uploadHotVideoFile(options), isError('network', 0));
  const resume = getHotVideoUploadResumes(options.storage)[0];
  assert.equal(resume.receivedBytes, CHUNK); assert.equal(resume.title, 'Original title');
  assert.equal(JSON.stringify(resume).includes('data'), false, 'only metadata is stored');
  const before = api.requests.length, sessions = []; offline = false;
  await uploadHotVideoFile({ ...options, title: 'A newly typed title', newId: () => assert.fail('resume must reuse its UUID'),
    onSession: value => sessions.push(value) });
  const continuation = api.requests.slice(before);
  assert.equal(continuation[0].method, 'GET'); assert.equal(continuation[0].path, ENDPOINT + '/' + ID);
  assert.equal(continuation.filter(request => request.method === 'PUT').length, 1);
  assert.equal(continuation.filter(request => request.method === 'POST' && request.path === ENDPOINT).length, 0);
  assert.ok(sessions.every(value => value.id === ID && value.title === 'Original title'));
  assert.deepEqual(getHotVideoUploadResumes(options.storage), []);
});

test('server expiry clears the old resume and starts one new UUID automatically', async () => {
  const file = localFile(48), storage = new MapStorage(); seed(storage, file);
  const api = server(file, (request, peer) => request.method === 'GET' && request.path.endsWith(ID)
    ? { status: 410, body: { error: 'expired' } } : peer.reply(request));
  const options = settings(file, api, { storage, title: 'Fresh title', newId: () => NEXT_ID });
  await uploadHotVideoFile(options);
  assert.equal(api.requests[0].method, 'GET'); assert.equal(api.requests[0].path, ENDPOINT + '/' + ID);
  assert.deepEqual(api.requests[1].json, { requestId: NEXT_ID, title: 'Fresh title', originalName: file.name, bytes: file.size });
  assert.equal(api.requests.filter(request => request.method === 'POST' && request.path === ENDPOINT).length, 1);
  assert.deepEqual(getHotVideoUploadResumes(storage), []); assert.equal(storage.getItem(STORAGE_KEY), null);
});

test('a replacement UUID after server expiry is validated before another API call', async () => {
  const file = localFile(48), storage = new MapStorage(); seed(storage, file);
  const api = server(file, () => ({ status: 410, body: {} }));
  await assert.rejects(uploadHotVideoFile(settings(file, api, { storage, newId: () => '../invalid' })), isError('http', 400));
  assert.equal(api.requests.length, 1); assert.deepEqual(getHotVideoUploadResumes(storage), []);
});

for (const status of [400, 401, 413]) test('initialization rejection ' + status + ' neither retries nor leaves a phantom resume', async () => {
  const file = localFile(48), api = server(file, () => ({ status, body: { error: 'rejected' } })), options = settings(file, api);
  await assert.rejects(uploadHotVideoFile(options), isError('http', status));
  assert.equal(api.requests.length, 1); assert.equal(api.requests[0].method, 'POST');
  assert.deepEqual(options.delays, []); assert.deepEqual(getHotVideoUploadResumes(options.storage), []);
});

test('an expired login during resume makes one GET and preserves the known session for login recovery', async () => {
  const file = localFile(48), storage = new MapStorage(); seed(storage, file);
  const api = server(file, () => ({ status: 401, body: {} })), options = settings(file, api, { storage });
  await assert.rejects(uploadHotVideoFile(options), isError('http', 401));
  assert.equal(api.requests.length, 1); assert.equal(api.requests[0].method, 'GET');
  assert.deepEqual(options.delays, []); assert.equal(getHotVideoUploadResumes(storage)[0].id, ID);
});

for (const [label, received] of [['no advance', () => 0], ['beyond this chunk', () => CHUNK + 1],
  ['beyond the file', file => file.size + 1], ['malformed offset', () => '1048576']]) {
  test('a PUT acknowledgement with ' + label + ' cannot skip bytes or retry forever', async () => {
    const file = localFile(2 * CHUNK);
    const api = server(file, (request, peer) => {
      if (request.method === 'PUT') return { status: 200, body: { ...peer.sessions.get(ID), receivedBytes: received(file) } };
      return peer.reply(request);
    });
    const options = settings(file, api);
    await assert.rejects(uploadHotVideoFile(options), isError('protocol', 0));
    assert.equal(puts(api).length, 3); assert.equal(gets(api).length, 3); assert.equal(completes(api).length, 0);
    assert.ok(puts(api).every(request => request.headers['X-Video-Offset'] === '0'));
    assert.equal(getHotVideoUploadResumes(options.storage)[0].receivedBytes, 0);
    assert.deepEqual(options.delays, [1000, 2000]);
  });
}

test('a lost completion reply after registration retries completion against the same completed session', async () => {
  const file = localFile(48); let dropped = false;
  const api = server(file, (request, peer) => {
    const response = peer.reply(request);
    if (request.path.endsWith('/complete') && !dropped) { dropped = true; throw network(); }
    return response;
  });
  const options = settings(file, api);
  assert.deepEqual(await uploadHotVideoFile(options), { videos: [] });
  assert.equal(api.registrations, 1); assert.equal(puts(api).length, 1); assert.equal(completes(api).length, 2);
  assert.equal(gets(api).length, 1); assert.equal(api.sessions.get(ID).state, 'complete');
  assert.deepEqual(getHotVideoUploadResumes(options.storage), []);
});

test('stopping keeps the server session and resume; explicit cancellation deletes both', async () => {
  const file = localFile(CHUNK + 48), controller = new AbortController();
  const api = server(file, (request, peer) => {
    const response = peer.reply(request);
    if (request.method === 'PUT') controller.abort();
    return response;
  });
  const options = settings(file, api, { signal: controller.signal });
  await assert.rejects(uploadHotVideoFile(options), isError('aborted', 0));
  assert.equal(api.sessions.get(ID).receivedBytes, CHUNK);
  assert.equal(getHotVideoUploadResumes(options.storage)[0].receivedBytes, CHUNK);
  assert.equal(api.requests.some(request => request.method === 'DELETE'), false); assert.deepEqual(options.delays, []);
  await cancelHotVideoUpload(ID, { transport: api.transport, storage: options.storage });
  assert.equal(api.requests.at(-1).method, 'DELETE'); assert.equal(api.requests.at(-1).path, ENDPOINT + '/' + ID);
  assert.equal(api.sessions.has(ID), false); assert.deepEqual(getHotVideoUploadResumes(options.storage), []);
});

test('an already removed session is a successful explicit cancellation and clears the resume', async () => {
  const file = localFile(48), storage = new MapStorage(); seed(storage, file);
  const requests = [];
  await cancelHotVideoUpload(ID, { storage, transport: async request => { requests.push(request); return { status: 410, body: {} }; } });
  assert.equal(requests.length, 1); assert.equal(requests[0].method, 'DELETE'); assert.deepEqual(getHotVideoUploadResumes(storage), []);
});

test('an empty title uses the local filename before creating the pending session', async () => {
  const file = localFile(48), api = server(file), observed = [];
  await uploadHotVideoFile(settings(file, api, { title: '  ', onSession: value => observed.push(value) }));
  const title = file.name.replace(/\.mp4$/i, '');
  assert.equal(api.requests[0].json.title, title); assert.ok(observed.every(value => value.title === title));
});

for (const [label, input] of [['long title', { title: 'x'.repeat(161) }], ['title control character', { title: 'bad\nname' }],
  ['long filename', { name: 'x'.repeat(252) + '.mp4' }]]) {
  test('invalid local metadata (' + label + ') is rejected before an API reservation', async () => {
    const file = localFile(48, input), api = server(file), options = settings(file, api, input);
    await assert.rejects(uploadHotVideoFile(options), isError('http', 400));
    assert.equal(api.requests.length, 0); assert.deepEqual(getHotVideoUploadResumes(options.storage), []);
  });
}

for (const event of ['onload', 'onerror', 'ontimeout']) test('XHR ' + event + ' with status zero is a network error and sends the exact ArrayBuffer', async t => {
  const instances = [], previous = globalThis.XMLHttpRequest;
  class FakeXHR {
    upload = {}; headers = {}; status = 0;
    constructor() { instances.push(this); }
    open(method, url) { this.method = method; this.url = url; }
    setRequestHeader(name, value) { this.headers[name] = value; }
    getResponseHeader() { return null; }
    send(body) { this.body = body; queueMicrotask(() => this[event]()); }
    abort() { this.onabort?.(); }
  }
  globalThis.XMLHttpRequest = FakeXHR;
  t.after(() => { if (previous === undefined) delete globalThis.XMLHttpRequest; else globalThis.XMLHttpRequest = previous; });
  const body = new ArrayBuffer(48);
  await assert.rejects(xhrHotVideoUploadRequest({ method: 'PUT', path: ENDPOINT + '/' + ID, body,
    headers: { 'X-Video-Offset': '0' } }), isError('network', 0));
  const xhr = instances[0];
  assert.equal(instances.length, 1); assert.equal(xhr.body, body); assert.equal(xhr.withCredentials, true);
  assert.equal(xhr.timeout, 90000); assert.equal(xhr.headers['Content-Type'], 'application/octet-stream');
  assert.equal(xhr.headers['X-Video-Offset'], '0');
});
