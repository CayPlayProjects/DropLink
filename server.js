const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");
const TEMP_ROOT = path.join(os.tmpdir(), "droplink-v022");

const MAX_MESSAGE_LENGTH = 8000;
const MAX_FILE_MB = Math.min(Math.max(Number(process.env.MAX_FILE_MB || 256), 1), 2048);
const MAX_ROOM_MB = Math.min(Math.max(Number(process.env.MAX_ROOM_MB || 1024), MAX_FILE_MB), 8192);
const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
const MAX_ROOM_FILE_BYTES = MAX_ROOM_MB * 1024 * 1024;
const MAX_ROOM_MESSAGES = 160;
const ALLOWED_TTLS = new Set([10, 30, 60]);
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const rooms = new Map();
const rateBuckets = new Map();

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

resetTempRoot();

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32Update(crc, buffer) {
  let value = crc >>> 0;
  for (const byte of buffer) value = CRC_TABLE[(value ^ byte) & 0xFF] ^ (value >>> 8);
  return value >>> 0;
}

function resetTempRoot() {
  try { fs.rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch {}
  fs.mkdirSync(TEMP_ROOT, { recursive: true });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(body);
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

function rateLimit(req, res, limit = 220, windowMs = 60_000) {
  const ip = clientIp(req);
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.startedAt > windowMs) {
    bucket = { startedAt: now, count: 0 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  if (bucket.count > limit) {
    sendJson(res, 429, { error: "Слишком много запросов. Попробуйте через минуту." });
    return false;
  }
  return true;
}

function cleanCode(raw) {
  return String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

function displayCode(code) {
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}

function randomCode() {
  for (let attempt = 0; attempt < 30; attempt++) {
    const bytes = crypto.randomBytes(6);
    let code = "";
    for (let i = 0; i < 6; i++) code += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
    if (!rooms.has(code)) return code;
  }
  throw new Error("Не удалось создать уникальный код комнаты");
}

function stripPrivateFileFields(entry) {
  if (entry.type !== "file") return { ...entry };
  const { filePath, crc32, ...rest } = entry;
  return rest;
}

function publicRoom(room) {
  return {
    code: room.code,
    displayCode: displayCode(room.code),
    createdAt: room.createdAt,
    expiresAt: new Date(room.expiresAt).toISOString(),
    messages: room.messages.map(stripPrivateFileFields)
  };
}

function getRoom(code) {
  const clean = cleanCode(code);
  const room = rooms.get(clean);
  if (!room) return null;
  if (room.expiresAt <= Date.now()) {
    expireRoom(clean);
    return null;
  }
  return room;
}

function broadcast(room, event, payload) {
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of room.clients.values()) {
    try { client.res.write(data); } catch {}
  }
}

function broadcastParticipants(room) {
  const peers = [...room.clients.values()].map(client => ({
    clientId: client.clientId,
    name: client.name
  }));
  broadcast(room, "participants", { count: peers.length, peers });
}

function removeFile(entry) {
  if (!entry || entry.type !== "file" || !entry.filePath) return;
  fs.rm(entry.filePath, { force: true }, () => {});
}

function expireRoom(code) {
  const room = rooms.get(code);
  if (!room) return;
  broadcast(room, "room-expired", { code });
  for (const client of room.clients.values()) {
    try { client.res.end(); } catch {}
  }
  for (const entry of room.messages) removeFile(entry);
  rooms.delete(code);
}

function addEntry(room, entry) {
  room.messages.push(entry);
  while (room.messages.length > MAX_ROOM_MESSAGES) {
    const removed = room.messages.shift();
    if (removed?.type === "file") {
      room.fileBytes = Math.max(0, room.fileBytes - (removed.size || 0));
      removeFile(removed);
    }
  }
}

function isPrivateIpv4(address) {
  const parts = String(address || "").split(".").map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function interfaceScore(name, address) {
  const n = String(name || "").toLowerCase();
  let score = 0;
  if (process.env.DROPLINK_PREFERRED_IP && address === process.env.DROPLINK_PREFERRED_IP) score += 1000;
  if (address.startsWith("192.168.")) score += 80;
  else if (address.startsWith("10.")) score += 55;
  else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score += 35;
  if (/wi-?fi|wlan|wireless|беспровод|ethernet|local area|локальн/.test(n)) score += 45;
  if (/veth|wsl|hyper-v|vethernet|docker|virtualbox|vmware|tailscale|zerotier|hamachi|wireguard|openvpn|tap|tun|loopback|bluetooth/.test(n)) score -= 120;
  return score;
}

function getLanCandidates(port = PORT) {
  const interfaces = os.networkInterfaces();
  const candidates = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    if (!entries) continue;
    for (const item of entries) {
      const family = item.family === 4 || item.family === "IPv4" ? 4 : 6;
      if (family !== 4 || item.internal || !item.address || !isPrivateIpv4(item.address)) continue;
      candidates.push({
        interface: name,
        address: item.address,
        url: `http://${item.address}:${port}`,
        score: interfaceScore(name, item.address)
      });
    }
  }
  const unique = [];
  const seen = new Set();
  for (const candidate of candidates.sort((a, b) => b.score - a.score)) {
    if (seen.has(candidate.address)) continue;
    seen.add(candidate.address);
    unique.push(candidate);
  }
  return unique;
}

function getLanIp() {
  return getLanCandidates()[0]?.address || null;
}

function safeHeaderDecode(value, fallback = "") {
  try { return decodeURIComponent(String(value || fallback)); }
  catch { return String(value || fallback); }
}

function sanitizeName(value, fallback = "Device") {
  return String(value || fallback).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40) || fallback;
}

function safeFilename(value) {
  return String(value || "file")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\/\\]/g, "_")
    .trim()
    .slice(0, 180) || "file";
}

function readJson(req, maxBytes = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;
    req.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        reject(new Error("Запрос слишком большой"));
        req.resume();
        return;
      }
      body += chunk;
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch { reject(new Error("Некорректный JSON")); }
    });
    req.on("error", reject);
  });
}

function writeRequestToFile(req, filePath, maxBytes) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(filePath, { flags: "wx" });
    let bytes = 0;
    let crc = 0xFFFFFFFF;
    let tooLarge = false;
    let writeError = null;

    output.on("error", error => {
      writeError = error;
      req.resume();
    });

    req.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > maxBytes) {
        tooLarge = true;
        if (!output.destroyed) output.destroy();
        req.resume();
        return;
      }
      if (tooLarge || writeError || output.destroyed) return;
      crc = crc32Update(crc, chunk);
      if (!output.write(chunk)) {
        req.pause();
        output.once("drain", () => req.resume());
      }
    });

    req.on("end", () => {
      if (tooLarge) {
        fs.rm(filePath, { force: true }, () => {});
        reject(new Error(`Максимальный размер файла — ${MAX_FILE_MB} MB`));
        return;
      }
      if (writeError) {
        fs.rm(filePath, { force: true }, () => {});
        reject(writeError);
        return;
      }
      output.end(() => resolve({ size: bytes, crc32: (crc ^ 0xFFFFFFFF) >>> 0 }));
    });

    req.on("error", error => {
      if (!output.destroyed) output.destroy();
      fs.rm(filePath, { force: true }, () => {});
      reject(error);
    });
  });
}

function routeMatch(pathname, regex) {
  const match = pathname.match(regex);
  return match ? match.slice(1).map(decodeURIComponent) : null;
}

function serveStatic(req, res, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const publicRoot = path.resolve(PUBLIC_DIR);
  const filePath = path.resolve(publicRoot, relative);
  if (filePath !== publicRoot && !filePath.startsWith(publicRoot + path.sep)) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  fs.stat(filePath, (error, stat) => {
    if (error || !stat.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not Found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": ext === ".html" ? "no-store" : "no-cache",
      "X-Content-Type-Options": "nosniff"
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

function parseRange(header, size) {
  const match = String(header || "").match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  let start;
  let end;
  if (match[1] === "" && match[2] !== "") {
    const suffix = Number(match[2]);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || start >= size) return null;
  end = Math.min(end, size - 1);
  return { start, end };
}


function dosDateTime(dateValue) {
  const date = new Date(dateValue || Date.now());
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function makeZipLocalHeader(entry, nameBuffer) {
  const { time, day } = dosDateTime(entry.createdAt);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(time, 10);
  header.writeUInt16LE(day, 12);
  header.writeUInt32LE(entry.crc32 >>> 0, 14);
  header.writeUInt32LE(entry.size >>> 0, 18);
  header.writeUInt32LE(entry.size >>> 0, 22);
  header.writeUInt16LE(nameBuffer.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function makeZipCentralHeader(entry, nameBuffer, offset) {
  const { time, day } = dosDateTime(entry.createdAt);
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(time, 12);
  header.writeUInt16LE(day, 14);
  header.writeUInt32LE(entry.crc32 >>> 0, 16);
  header.writeUInt32LE(entry.size >>> 0, 20);
  header.writeUInt32LE(entry.size >>> 0, 24);
  header.writeUInt16LE(nameBuffer.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset >>> 0, 42);
  return header;
}

function makeZipEnd(count, centralSize, centralOffset) {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(count, 8);
  end.writeUInt16LE(count, 10);
  end.writeUInt32LE(centralSize >>> 0, 12);
  end.writeUInt32LE(centralOffset >>> 0, 16);
  end.writeUInt16LE(0, 20);
  return end;
}

function uniqueZipNames(files) {
  const counts = new Map();
  return files.map(entry => {
    const original = safeFilename(entry.name || "file");
    const key = original.toLowerCase();
    const count = (counts.get(key) || 0) + 1;
    counts.set(key, count);
    if (count === 1) return { entry, zipName: original };
    const ext = path.extname(original);
    const base = ext ? original.slice(0, -ext.length) : original;
    return { entry, zipName: `${base} (${count})${ext}` };
  });
}

function streamFileWithoutEnding(res, filePath) {
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    input.on("error", reject);
    input.on("end", resolve);
    input.pipe(res, { end: false });
  });
}

async function sendRoomZip(req, res, room) {
  const files = room.messages.filter(item => item.type === "file" && item.filePath && fs.existsSync(item.filePath));
  if (!files.length) {
    sendJson(res, 404, { error: "В комнате пока нет файлов" });
    return;
  }

  const named = uniqueZipNames(files).map(({ entry, zipName }) => ({
    entry,
    nameBuffer: Buffer.from(zipName, "utf8")
  }));

  let localOffset = 0;
  const records = [];
  for (const item of named) {
    const localHeader = makeZipLocalHeader(item.entry, item.nameBuffer);
    records.push({ ...item, localHeader, offset: localOffset });
    localOffset += localHeader.length + item.nameBuffer.length + item.entry.size;
  }

  const centralOffset = localOffset;
  let centralSize = 0;
  const centralParts = records.map(item => {
    const header = makeZipCentralHeader(item.entry, item.nameBuffer, item.offset);
    centralSize += header.length + item.nameBuffer.length;
    return { header, nameBuffer: item.nameBuffer };
  });
  const end = makeZipEnd(records.length, centralSize, centralOffset);
  const totalSize = centralOffset + centralSize + end.length;
  const archiveName = `DropLink-${displayCode(room.code)}-files.zip`;
  const encoded = encodeURIComponent(archiveName).replace(/'/g, "%27");

  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Length": totalSize,
    "Content-Disposition": `attachment; filename*=UTF-8''${encoded}`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  if (req.method === "HEAD") return res.end();

  try {
    for (const item of records) {
      res.write(item.localHeader);
      res.write(item.nameBuffer);
      await streamFileWithoutEnding(res, item.entry.filePath);
    }
    for (const item of centralParts) {
      res.write(item.header);
      res.write(item.nameBuffer);
    }
    res.end(end);
  } catch {
    try { res.destroy(); } catch {}
  }
}

const server = http.createServer(async (req, res) => {
  let url;
  try { url = new URL(req.url, "http://localhost"); }
  catch { res.writeHead(400).end("Bad Request"); return; }

  const pathname = decodeURIComponent(url.pathname);
  if (pathname.startsWith("/api/") && pathname !== "/api/info" && pathname !== "/api/health") {
    if (!rateLimit(req, res)) return;
  }

  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, { ok: true, version: "0.2.2", rooms: rooms.size, host: HOST, port: PORT });
    return;
  }

  if (req.method === "GET" && pathname === "/api/info") {
    const hostHeader = String(req.headers.host || `localhost:${PORT}`);
    const protocol = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
    const origin = `${protocol}://${hostHeader}`;
    const hostOnly = hostHeader.split(":")[0].replace(/^\[|\]$/g, "");
    const isLocalHost = hostOnly === "localhost" || hostOnly === "127.0.0.1" || hostOnly === "::1";
    const candidates = getLanCandidates(PORT);
    const lanCandidates = candidates.map((item, index) => ({
      ...item,
      url: `${protocol}://${item.address}:${PORT}`,
      recommended: index === 0
    }));
    const lanUrl = isLocalHost ? (lanCandidates[0]?.url || origin) : origin;
    sendJson(res, 200, {
      version: "0.2.2",
      origin,
      lanUrl,
      lanCandidates,
      port: PORT,
      hostname: os.hostname(),
      limits: { fileMb: MAX_FILE_MB, roomMb: MAX_ROOM_MB, messageChars: MAX_MESSAGE_LENGTH }
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/rooms") {
    try {
      const body = await readJson(req);
      const ttl = Number(body.ttlMinutes || 30);
      if (!ALLOWED_TTLS.has(ttl)) {
        sendJson(res, 400, { error: "Допустимое время комнаты: 10, 30 или 60 минут" });
        return;
      }
      const code = randomCode();
      const now = Date.now();
      const room = {
        code,
        createdAt: new Date(now).toISOString(),
        expiresAt: now + ttl * 60_000,
        messages: [],
        clients: new Map(),
        fileBytes: 0
      };
      rooms.set(code, room);
      sendJson(res, 201, {
        code,
        displayCode: displayCode(code),
        createdAt: room.createdAt,
        expiresAt: new Date(room.expiresAt).toISOString()
      });
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Не удалось создать комнату" });
    }
    return;
  }

  const roomInfo = routeMatch(pathname, /^\/api\/rooms\/([A-Za-z0-9-]+)$/);
  if (req.method === "GET" && roomInfo) {
    const room = getRoom(roomInfo[0]);
    if (!room) { sendJson(res, 404, { error: "Комната не найдена или уже удалена" }); return; }
    sendJson(res, 200, publicRoom(room));
    return;
  }

  const eventsMatch = routeMatch(pathname, /^\/api\/rooms\/([A-Za-z0-9-]+)\/events$/);
  if (req.method === "GET" && eventsMatch) {
    const room = getRoom(eventsMatch[0]);
    if (!room) { sendJson(res, 404, { error: "Комната не найдена или уже удалена" }); return; }
    const clientId = String(url.searchParams.get("clientId") || crypto.randomUUID()).slice(0, 80);
    const name = sanitizeName(url.searchParams.get("name"), "Device");
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write(`event: hello\ndata: ${JSON.stringify({ code: room.code })}\n\n`);
    room.clients.set(clientId, { res, clientId, name });
    broadcastParticipants(room);
    const heartbeat = setInterval(() => {
      try { res.write(`: ping ${Date.now()}\n\n`); } catch {}
    }, 20_000);
    req.on("close", () => {
      clearInterval(heartbeat);
      const current = room.clients.get(clientId);
      if (current?.res === res) {
        room.clients.delete(clientId);
        broadcastParticipants(room);
      }
    });
    return;
  }

  const messageMatch = routeMatch(pathname, /^\/api\/rooms\/([A-Za-z0-9-]+)\/messages$/);
  if (req.method === "POST" && messageMatch) {
    const room = getRoom(messageMatch[0]);
    if (!room) { sendJson(res, 404, { error: "Комната не найдена или уже удалена" }); return; }
    try {
      const body = await readJson(req);
      const text = String(body.text || "").trim();
      if (!text) { sendJson(res, 400, { error: "Нельзя отправить пустое сообщение" }); return; }
      if (text.length > MAX_MESSAGE_LENGTH) {
        sendJson(res, 400, { error: `Максимальная длина — ${MAX_MESSAGE_LENGTH} символов` });
        return;
      }
      const entry = {
        id: crypto.randomUUID(), type: "message", text,
        sender: sanitizeName(body.sender, "Device"),
        clientId: String(body.clientId || "").slice(0, 80),
        createdAt: new Date().toISOString()
      };
      addEntry(room, entry);
      broadcast(room, "message", entry);
      sendJson(res, 201, entry);
    } catch (error) {
      sendJson(res, 400, { error: error.message || "Не удалось отправить сообщение" });
    }
    return;
  }

  const fileUploadMatch = routeMatch(pathname, /^\/api\/rooms\/([A-Za-z0-9-]+)\/files$/);
  if (req.method === "POST" && fileUploadMatch) {
    const room = getRoom(fileUploadMatch[0]);
    if (!room) { sendJson(res, 404, { error: "Комната не найдена или уже удалена" }); return; }

    const declaredLength = Number(req.headers["content-length"] || 0);
    if (declaredLength > MAX_FILE_BYTES) {
      sendJson(res, 413, { error: `Максимальный размер файла — ${MAX_FILE_MB} MB` });
      req.resume();
      return;
    }
    if (declaredLength && room.fileBytes + declaredLength > MAX_ROOM_FILE_BYTES) {
      sendJson(res, 413, { error: `Лимит файлов комнаты — ${MAX_ROOM_MB} MB` });
      req.resume();
      return;
    }

    const name = safeFilename(safeHeaderDecode(req.headers["x-file-name"], "file"));
    const mime = String(req.headers["x-file-type"] || "application/octet-stream").slice(0, 120);
    const sender = sanitizeName(safeHeaderDecode(req.headers["x-sender"], "Device"));
    const clientId = String(req.headers["x-client-id"] || "").slice(0, 80);
    const filePath = path.join(TEMP_ROOT, `${Date.now()}-${crypto.randomUUID()}.bin`);

    try {
      const upload = await writeRequestToFile(req, filePath, MAX_FILE_BYTES);
      const size = upload.size;
      if (room.fileBytes + size > MAX_ROOM_FILE_BYTES) {
        fs.rm(filePath, { force: true }, () => {});
        sendJson(res, 413, { error: `Лимит файлов комнаты — ${MAX_ROOM_MB} MB` });
        return;
      }
      const entry = {
        id: crypto.randomUUID(), type: "file", name, mime, size,
        sender, clientId, createdAt: new Date().toISOString(), filePath, crc32: upload.crc32
      };
      room.fileBytes += size;
      addEntry(room, entry);
      const publicEntry = stripPrivateFileFields(entry);
      broadcast(room, "message", publicEntry);
      sendJson(res, 201, publicEntry);
    } catch (error) {
      fs.rm(filePath, { force: true }, () => {});
      if (!res.headersSent) sendJson(res, 400, { error: error.message || "Не удалось загрузить файл" });
    }
    return;
  }

  const roomZipMatch = routeMatch(pathname, /^\/api\/rooms\/([A-Za-z0-9-]+)\/files\.zip$/);
  if ((req.method === "GET" || req.method === "HEAD") && roomZipMatch) {
    const room = getRoom(roomZipMatch[0]);
    if (!room) { sendJson(res, 404, { error: "Комната не найдена или уже удалена" }); return; }
    await sendRoomZip(req, res, room);
    return;
  }

  const fileDownloadMatch = routeMatch(pathname, /^\/api\/rooms\/([A-Za-z0-9-]+)\/files\/([A-Za-z0-9-]+)$/);
  if ((req.method === "GET" || req.method === "HEAD") && fileDownloadMatch) {
    const room = getRoom(fileDownloadMatch[0]);
    if (!room) { sendJson(res, 404, { error: "Комната не найдена или уже удалена" }); return; }
    const entry = room.messages.find(item => item.type === "file" && item.id === fileDownloadMatch[1]);
    if (!entry || !entry.filePath || !fs.existsSync(entry.filePath)) {
      sendJson(res, 404, { error: "Файл не найден" });
      return;
    }

    const encodedName = encodeURIComponent(entry.name).replace(/'/g, "%27");
    const range = parseRange(req.headers.range, entry.size);
    const common = {
      "Content-Type": entry.mime || "application/octet-stream",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodedName}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Accept-Ranges": "bytes"
    };

    if (req.headers.range && !range) {
      res.writeHead(416, { ...common, "Content-Range": `bytes */${entry.size}` });
      res.end();
      return;
    }

    if (range) {
      const length = range.end - range.start + 1;
      res.writeHead(206, {
        ...common,
        "Content-Length": length,
        "Content-Range": `bytes ${range.start}-${range.end}/${entry.size}`
      });
      if (req.method === "HEAD") return res.end();
      fs.createReadStream(entry.filePath, { start: range.start, end: range.end }).pipe(res);
      return;
    }

    res.writeHead(200, { ...common, "Content-Length": entry.size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(entry.filePath).pipe(res);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res, pathname);
    return;
  }
  res.writeHead(405, { "Allow": "GET, HEAD, POST" }).end("Method Not Allowed");
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) if (room.expiresAt <= now) expireRoom(code);
  for (const [ip, bucket] of rateBuckets) if (now - bucket.startedAt > 5 * 60_000) rateBuckets.delete(ip);
}, 30_000).unref();

function shutdown() {
  for (const code of [...rooms.keys()]) expireRoom(code);
  try { fs.rmSync(TEMP_ROOT, { recursive: true, force: true }); } catch {}
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

server.listen(PORT, HOST, () => {
  const lanIp = getLanIp();
  console.log("");
  console.log("DropLink v0.2.2 is running");
  console.log(`Local:   http://localhost:${PORT}`);
  const candidates = getLanCandidates(PORT);
  if (lanIp) console.log(`Network: http://${lanIp}:${PORT}  <- попробуй этот адрес на телефоне`);
  else console.log("Network: LAN IPv4 address not found");
  if (candidates.length > 1) {
    console.log("Other LAN addresses:");
    for (const item of candidates.slice(1)) console.log(`         http://${item.address}:${PORT}  (${item.interface})`);
  }
  console.log(`Listening: ${HOST}:${PORT}`);
  console.log(`File limit: ${MAX_FILE_MB} MB • Room limit: ${MAX_ROOM_MB} MB`);
  console.log("");
});
