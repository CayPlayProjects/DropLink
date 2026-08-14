const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");

const MAX_MESSAGE_LENGTH = 8000;
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_ROOM_FILE_BYTES = 48 * 1024 * 1024;
const MAX_ROOM_MESSAGES = 120;
const ALLOWED_TTLS = new Set([10, 30, 60]);
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const rooms = new Map();
const rateBuckets = new Map();

const MIME = {
  ".html":"text/html; charset=utf-8",
  ".css":"text/css; charset=utf-8",
  ".js":"application/javascript; charset=utf-8",
  ".svg":"image/svg+xml; charset=utf-8",
  ".txt":"text/plain; charset=utf-8"
};

function sendJson(res, status, data){
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type":"application/json; charset=utf-8",
    "Content-Length":Buffer.byteLength(body),
    "Cache-Control":"no-store",
    "X-Content-Type-Options":"nosniff"
  });
  res.end(body);
}

function clientIp(req){
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress || "unknown";
}

function rateLimit(req, res, limit=140, windowMs=60_000){
  const ip = clientIp(req);
  const now = Date.now();
  let bucket = rateBuckets.get(ip);

  if(!bucket || now - bucket.startedAt > windowMs){
    bucket = {startedAt:now, count:0};
    rateBuckets.set(ip, bucket);
  }

  bucket.count += 1;

  if(bucket.count > limit){
    sendJson(res, 429, {error:"Слишком много запросов. Попробуйте через минуту."});
    return false;
  }

  return true;
}

function cleanCode(raw){
  return String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,6);
}

function displayCode(code){
  return `${code.slice(0,3)}-${code.slice(3)}`;
}

function randomCode(){
  for(let attempt=0; attempt<20; attempt++){
    const bytes = crypto.randomBytes(6);
    let code = "";
    for(let i=0; i<6; i++){
      code += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
    }
    if(!rooms.has(code)) return code;
  }
  throw new Error("Не удалось создать уникальный код комнаты");
}

function publicRoom(room){
  return {
    code:room.code,
    displayCode:displayCode(room.code),
    createdAt:room.createdAt,
    expiresAt:room.expiresAt,
    messages:room.messages.map(stripFileBuffer)
  };
}

function stripFileBuffer(entry){
  if(entry.type !== "file") return {...entry};
  const {buffer, ...rest} = entry;
  return rest;
}

function getRoom(code){
  const clean = cleanCode(code);
  const room = rooms.get(clean);
  if(!room) return null;

  if(room.expiresAt <= Date.now()){
    expireRoom(clean);
    return null;
  }

  return room;
}

function broadcast(room, event, payload){
  const data = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for(const client of room.clients.values()){
    try{ client.res.write(data); }catch{}
  }
}

function broadcastParticipants(room){
  const peers = [...room.clients.values()].map(client => ({
    clientId:client.clientId,
    name:client.name
  }));

  broadcast(room, "participants", {
    count:peers.length,
    peers
  });
}

function expireRoom(code){
  const room = rooms.get(code);
  if(!room) return;

  broadcast(room, "room-expired", {code});
  for(const client of room.clients.values()){
    try{ client.res.end(); }catch{}
  }

  rooms.delete(code);
}

function addEntry(room, entry){
  room.messages.push(entry);

  while(room.messages.length > MAX_ROOM_MESSAGES){
    const removed = room.messages.shift();
    if(removed?.type === "file"){
      room.fileBytes -= removed.size || 0;
    }
  }
}

function isPrivateIpv4(address){
  const parts = String(address || "").split(".").map(Number);
  if(parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;

  return (
    parts[0] === 10 ||
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
    (parts[0] === 192 && parts[1] === 168)
  );
}

function interfaceScore(name, address){
  const n = String(name || "").toLowerCase();
  let score = 0;

  // Prefer addresses that phones on ordinary home Wi-Fi can usually reach.
  if(address.startsWith("192.168.")) score += 80;
  else if(address.startsWith("10.")) score += 55;
  else if(/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score += 35;

  // Strong preference for physical LAN adapters.
  if(/wi-?fi|wlan|wireless|беспровод|ethernet|local area|локальн/.test(n)) score += 45;

  // Strongly de-prioritize virtual/VPN adapters.
  if(/veth|wsl|hyper-v|vethernet|docker|virtualbox|vmware|tailscale|zerotier|hamachi|wireguard|openvpn|tap|tun|loopback|bluetooth/.test(n)) {
    score -= 120;
  }

  return score;
}

function getLanCandidates(port=PORT){
  const interfaces = os.networkInterfaces();
  const candidates = [];

  for(const [name, entries] of Object.entries(interfaces)){
    if(!entries) continue;

    for(const item of entries){
      const family = item.family === 4 || item.family === "IPv4" ? 4 : 6;
      if(family !== 4 || item.internal || !item.address) continue;
      if(!isPrivateIpv4(item.address)) continue;

      candidates.push({
        interface:name,
        address:item.address,
        url:`http://${item.address}:${port}`,
        score:interfaceScore(name, item.address)
      });
    }
  }

  // Remove duplicates and sort best first.
  const unique = [];
  const seen = new Set();

  for(const candidate of candidates.sort((a,b) => b.score - a.score)){
    if(seen.has(candidate.address)) continue;
    seen.add(candidate.address);
    unique.push(candidate);
  }

  return unique;
}

function getLanIp(){
  return getLanCandidates()[0]?.address || null;
}

function safeHeaderDecode(value, fallback=""){
  try{
    return decodeURIComponent(String(value || fallback));
  }catch{
    return String(value || fallback);
  }
}

function sanitizeName(value, fallback="Device"){
  return String(value || fallback)
    .replace(/[\u0000-\u001f\u007f]/g,"")
    .trim()
    .slice(0,32) || fallback;
}

function safeFilename(value){
  return String(value || "file")
    .replace(/[\u0000-\u001f\u007f]/g,"")
    .replace(/[\/\\]/g,"_")
    .trim()
    .slice(0,180) || "file";
}

function readJson(req, maxBytes=32*1024){
  return new Promise((resolve, reject) => {
    let body = "";
    let bytes = 0;

    req.on("data", chunk => {
      bytes += chunk.length;
      if(bytes > maxBytes){
        reject(new Error("Запрос слишком большой"));
        req.destroy();
        return;
      }
      body += chunk;
    });

    req.on("end", () => {
      try{
        resolve(JSON.parse(body || "{}"));
      }catch{
        reject(new Error("Некорректный JSON"));
      }
    });

    req.on("error", reject);
  });
}

function readBinary(req, maxBytes){
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;

    req.on("data", chunk => {
      bytes += chunk.length;
      if(bytes > maxBytes){
        reject(new Error(`Максимальный размер файла — ${Math.round(maxBytes/1024/1024)} MB`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function routeMatch(pathname, regex){
  const match = pathname.match(regex);
  return match ? match.slice(1).map(decodeURIComponent) : null;
}

function serveStatic(req, res, pathname){
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/,"");
  const publicRoot = path.resolve(PUBLIC_DIR);
  const filePath = path.resolve(publicRoot, relative);

  if(filePath !== publicRoot && !filePath.startsWith(publicRoot + path.sep)){
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.stat(filePath, (error, stat) => {
    if(error || !stat.isFile()){
      res.writeHead(404, {"Content-Type":"text/plain; charset=utf-8"}).end("Not Found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type":MIME[ext] || "application/octet-stream",
      "Cache-Control":ext === ".html" ? "no-store" : "no-cache",
      "X-Content-Type-Options":"nosniff"
    });

    if(req.method === "HEAD"){
      res.end();
      return;
    }

    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  let url;
  try{
    url = new URL(req.url, "http://localhost");
  }catch{
    res.writeHead(400).end("Bad Request");
    return;
  }

  const pathname = decodeURIComponent(url.pathname);

  if(pathname.startsWith("/api/") && pathname !== "/api/info"){
    if(!rateLimit(req, res)) return;
  }

  if(req.method === "GET" && pathname === "/api/info"){
    const hostHeader = String(req.headers.host || `localhost:${PORT}`);
    const protocol = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
    const origin = `${protocol}://${hostHeader}`;

    const hostOnly = hostHeader.split(":")[0].replace(/^\[|\]$/g,"");
    const isLocalHost = hostOnly === "localhost" || hostOnly === "127.0.0.1" || hostOnly === "::1";
    const candidates = getLanCandidates(PORT);

    const lanCandidates = candidates.map((item, index) => ({
      ...item,
      url:`${protocol}://${item.address}:${PORT}`,
      recommended:index === 0
    }));

    const lanUrl = isLocalHost
      ? (lanCandidates[0]?.url || origin)
      : origin;

    sendJson(res, 200, {
      version:"0.1.5",
      origin,
      lanUrl,
      lanCandidates,
      port:PORT,
      hostname:os.hostname()
    });
    return;
  }

  if(req.method === "POST" && pathname === "/api/rooms"){
    try{
      const body = await readJson(req);
      const ttl = Number(body.ttlMinutes || 30);
      if(!ALLOWED_TTLS.has(ttl)){
        sendJson(res, 400, {error:"Допустимое время комнаты: 10, 30 или 60 минут"});
        return;
      }

      const code = randomCode();
      const now = Date.now();
      const room = {
        code,
        createdAt:new Date(now).toISOString(),
        expiresAt:now + ttl * 60_000,
        messages:[],
        clients:new Map(),
        fileBytes:0
      };

      rooms.set(code, room);

      sendJson(res, 201, {
        code,
        displayCode:displayCode(code),
        createdAt:room.createdAt,
        expiresAt:new Date(room.expiresAt).toISOString()
      });
    }catch(error){
      sendJson(res, 400, {error:error.message || "Не удалось создать комнату"});
    }
    return;
  }

  const roomInfo = routeMatch(pathname, /^\/api\/rooms\/([A-Za-z0-9-]+)$/);
  if(req.method === "GET" && roomInfo){
    const room = getRoom(roomInfo[0]);
    if(!room){
      sendJson(res, 404, {error:"Комната не найдена или уже удалена"});
      return;
    }
    sendJson(res, 200, publicRoom(room));
    return;
  }

  const eventsMatch = routeMatch(pathname, /^\/api\/rooms\/([A-Za-z0-9-]+)\/events$/);
  if(req.method === "GET" && eventsMatch){
    const room = getRoom(eventsMatch[0]);
    if(!room){
      sendJson(res, 404, {error:"Комната не найдена или уже удалена"});
      return;
    }

    const clientId = String(url.searchParams.get("clientId") || crypto.randomUUID()).slice(0,80);
    const name = sanitizeName(url.searchParams.get("name"), "Device");

    res.writeHead(200, {
      "Content-Type":"text/event-stream; charset=utf-8",
      "Cache-Control":"no-cache, no-transform",
      "Connection":"keep-alive",
      "X-Accel-Buffering":"no"
    });

    res.write(`event: hello\ndata: ${JSON.stringify({code:room.code})}\n\n`);

    room.clients.set(clientId, {res, clientId, name});
    broadcastParticipants(room);

    const heartbeat = setInterval(() => {
      try{ res.write(`: ping ${Date.now()}\n\n`); }catch{}
    }, 20_000);

    req.on("close", () => {
      clearInterval(heartbeat);
      const current = room.clients.get(clientId);
      if(current?.res === res){
        room.clients.delete(clientId);
        broadcastParticipants(room);
      }
    });

    return;
  }

  const messageMatch = routeMatch(pathname, /^\/api\/rooms\/([A-Za-z0-9-]+)\/messages$/);
  if(req.method === "POST" && messageMatch){
    const room = getRoom(messageMatch[0]);
    if(!room){
      sendJson(res, 404, {error:"Комната не найдена или уже удалена"});
      return;
    }

    try{
      const body = await readJson(req);
      const text = String(body.text || "").trim();
      if(!text){
        sendJson(res, 400, {error:"Нельзя отправить пустое сообщение"});
        return;
      }
      if(text.length > MAX_MESSAGE_LENGTH){
        sendJson(res, 400, {error:`Максимальная длина — ${MAX_MESSAGE_LENGTH} символов`});
        return;
      }

      const entry = {
        id:crypto.randomUUID(),
        type:"message",
        text,
        sender:sanitizeName(body.sender, "Device"),
        clientId:String(body.clientId || "").slice(0,80),
        createdAt:new Date().toISOString()
      };

      addEntry(room, entry);
      broadcast(room, "message", entry);
      sendJson(res, 201, entry);
    }catch(error){
      sendJson(res, 400, {error:error.message || "Не удалось отправить сообщение"});
    }
    return;
  }

  const fileUploadMatch = routeMatch(pathname, /^\/api\/rooms\/([A-Za-z0-9-]+)\/files$/);
  if(req.method === "POST" && fileUploadMatch){
    const room = getRoom(fileUploadMatch[0]);
    if(!room){
      sendJson(res, 404, {error:"Комната не найдена или уже удалена"});
      return;
    }

    const length = Number(req.headers["content-length"] || 0);
    if(length > MAX_FILE_BYTES){
      sendJson(res, 413, {error:"Максимальный размер файла — 12 MB"});
      req.resume();
      return;
    }

    if(room.fileBytes + length > MAX_ROOM_FILE_BYTES){
      sendJson(res, 413, {error:"В этой комнате уже слишком много файлов"});
      req.resume();
      return;
    }

    try{
      const buffer = await readBinary(req, MAX_FILE_BYTES);

      if(room.fileBytes + buffer.length > MAX_ROOM_FILE_BYTES){
        sendJson(res, 413, {error:"Лимит файлов комнаты — 48 MB"});
        return;
      }

      const name = safeFilename(safeHeaderDecode(req.headers["x-file-name"], "file"));
      const mime = String(req.headers["x-file-type"] || "application/octet-stream").slice(0,120);
      const sender = sanitizeName(safeHeaderDecode(req.headers["x-sender"], "Device"));
      const clientId = String(req.headers["x-client-id"] || "").slice(0,80);

      const entry = {
        id:crypto.randomUUID(),
        type:"file",
        name,
        mime,
        size:buffer.length,
        sender,
        clientId,
        createdAt:new Date().toISOString(),
        buffer
      };

      room.fileBytes += buffer.length;
      addEntry(room, entry);

      const publicEntry = stripFileBuffer(entry);
      broadcast(room, "message", publicEntry);
      sendJson(res, 201, publicEntry);
    }catch(error){
      if(!res.headersSent){
        sendJson(res, 400, {error:error.message || "Не удалось загрузить файл"});
      }
    }
    return;
  }

  const fileDownloadMatch = routeMatch(pathname, /^\/api\/rooms\/([A-Za-z0-9-]+)\/files\/([A-Za-z0-9-]+)$/);
  if(req.method === "GET" && fileDownloadMatch){
    const room = getRoom(fileDownloadMatch[0]);
    if(!room){
      sendJson(res, 404, {error:"Комната не найдена или уже удалена"});
      return;
    }

    const entry = room.messages.find(item => item.type === "file" && item.id === fileDownloadMatch[1]);
    if(!entry || !entry.buffer){
      sendJson(res, 404, {error:"Файл не найден"});
      return;
    }

    const encodedName = encodeURIComponent(entry.name).replace(/'/g,"%27");
    res.writeHead(200, {
      "Content-Type":entry.mime || "application/octet-stream",
      "Content-Length":entry.buffer.length,
      "Content-Disposition":`attachment; filename*=UTF-8''${encodedName}`,
      "Cache-Control":"no-store",
      "X-Content-Type-Options":"nosniff"
    });
    res.end(entry.buffer);
    return;
  }

  if(req.method === "GET" || req.method === "HEAD"){
    serveStatic(req, res, pathname);
    return;
  }

  res.writeHead(405, {"Allow":"GET, HEAD, POST"}).end("Method Not Allowed");
});

setInterval(() => {
  const now = Date.now();

  for(const [code, room] of rooms){
    if(room.expiresAt <= now){
      expireRoom(code);
    }
  }

  for(const [ip, bucket] of rateBuckets){
    if(now - bucket.startedAt > 5 * 60_000){
      rateBuckets.delete(ip);
    }
  }
}, 30_000).unref();

server.listen(PORT, HOST, () => {
  const lanIp = getLanIp();
  console.log("");
  console.log("DropLink v0.1.5 is running");
  console.log(`Local:   http://localhost:${PORT}`);
  if(lanIp) console.log(`Network: http://${lanIp}:${PORT}`);
  console.log("");
  console.log("Open the Network URL on another device connected to the same Wi-Fi.");
});
