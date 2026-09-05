const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  room: null,
  source: null,
  ttl: 30,
  info: null,
  selectedLanUrl: null,
  clientId: getClientId(),
  deviceName: getDeviceName(),
  countdownTimer: null,
  fileEntries: new Map(),
  uploadBusy: false,
  pendingFiles: []
};

const landingView = $("#landingView");
const roomView = $("#roomView");
const toast = $("#toast");
const toastText = $("#toastText");
let toastTimer = null;

function getClientId() {
  let id = sessionStorage.getItem("droplink-client");
  if (!id) {
    id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    sessionStorage.setItem("droplink-client", id);
  }
  return id;
}

function getDeviceName() {
  const ua = navigator.userAgent || "";
  if (/iPhone/i.test(ua)) return "iPhone";
  if (/iPad/i.test(ua)) return "iPad";
  if (/Android/i.test(ua)) return "Android";
  if (/Windows/i.test(ua)) return "Windows PC";
  if (/Macintosh|Mac OS X/i.test(ua)) return "Mac";
  if (/Linux/i.test(ua)) return "Linux";
  return "Browser";
}

function showToast(message, error = false) {
  toastText.textContent = message;
  toast.classList.toggle("error", error);
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function formatCode(raw) {
  const clean = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  return clean.length > 3 ? `${clean.slice(0, 3)}-${clean.slice(3)}` : clean;
}

function apiCode(code) {
  return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} КБ`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} МБ`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} ГБ`;
}

function linkify(text) {
  const escaped = escapeHtml(text);
  return escaped.replace(/(https?:\/\/[^\s<]+)/gi, url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
}

function isUrl(text) {
  try {
    const value = String(text).trim();
    if (!/^https?:\/\//i.test(value)) return false;
    new URL(value);
    return true;
  } catch { return false; }
}

function switchDeck(mode) {
  const create = mode === "create";
  $("#createTab").classList.toggle("active", create);
  $("#joinTab").classList.toggle("active", !create);
  $("#createTab").setAttribute("aria-selected", String(create));
  $("#joinTab").setAttribute("aria-selected", String(!create));
  $("#createPanel").classList.toggle("active", create);
  $("#joinPanel").classList.toggle("active", !create);
  if (!create) setTimeout(() => $("#joinCodeInput").focus(), 80);
}

$("#createTab").onclick = () => switchDeck("create");
$("#joinTab").onclick = () => switchDeck("join");

$$('[data-ttl]').forEach(button => {
  button.onclick = () => {
    state.ttl = Number(button.dataset.ttl);
    $$('[data-ttl]').forEach(item => item.classList.toggle("active", item === button));
  };
});

$("#joinCodeInput").addEventListener("input", event => event.target.value = formatCode(event.target.value));
$("#joinCodeInput").addEventListener("keydown", event => { if (event.key === "Enter") joinRequestedRoom(); });

async function loadInfo({ preserveSelection = true } = {}) {
  try {
    const previous = preserveSelection ? state.selectedLanUrl : null;
    const response = await fetch(`/api/info?ts=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error("info failed");
    state.info = await response.json();
    const candidates = state.info.lanCandidates || [];
    const stillExists = previous && candidates.some(item => item.url === previous);
    state.selectedLanUrl = stillExists ? previous : (candidates[0]?.url || state.info.lanUrl || state.info.origin || location.origin);
    $("#networkLabel").textContent = candidates.length ? "ЛОКАЛЬНАЯ СЕТЬ ГОТОВА" : "ТОЛЬКО ЭТОТ ПК";
    if (state.info.limits?.fileMb) $("#fileLimitLabel").textContent = `до ${state.info.limits.fileMb} МБ на файл`;
    renderNetworkOptions();
  } catch {
    $("#networkLabel").textContent = "СЕТЬ НЕ ОПРЕДЕЛЕНА";
  }
}

function renderNetworkOptions() {
  const select = $("#networkSelect");
  if (!select || !state.info) return;
  const candidates = state.info.lanCandidates || [];
  select.innerHTML = "";
  if (candidates.length) {
    for (const item of candidates) {
      const option = document.createElement("option");
      option.value = item.url;
      option.textContent = `${item.recommended ? "★ " : ""}${item.address} — ${item.interface}`;
      select.appendChild(option);
    }
  } else {
    const option = document.createElement("option");
    option.value = state.info.origin || location.origin;
    option.textContent = "Только localhost — LAN IP не найден";
    select.appendChild(option);
  }
  select.value = state.selectedLanUrl || select.options[0]?.value || "";
  select.onchange = () => {
    state.selectedLanUrl = select.value;
    renderInvite();
    showToast("QR обновлён для выбранного адреса");
  };
}

async function createRoom() {
  const button = $("#createRoomButton");
  button.disabled = true;
  try {
    const response = await fetch("/api/rooms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ttlMinutes: state.ttl })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Не удалось создать комнату");
    await enterRoom(data.code);
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; }
}

async function joinRequestedRoom() {
  const code = apiCode($("#joinCodeInput").value);
  if (code.length !== 6) return showToast("Введите полный код комнаты", true);
  await enterRoom(code);
}

$("#createRoomButton").onclick = createRoom;
$("#joinRoomButton").onclick = joinRequestedRoom;

async function enterRoom(code) {
  try {
    const clean = apiCode(code);
    const response = await fetch(`/api/rooms/${encodeURIComponent(clean)}`, { cache: "no-store" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Комната не найдена");

    state.room = data;
    sessionStorage.setItem("droplink-room", clean);
    landingView.hidden = true;
    roomView.hidden = false;
    $("#roomCodeTitle").textContent = formatCode(clean);

    renderHistory(data.messages || []);
    renderInvite();
    startCountdown();
    connectEvents();

    history.replaceState({}, "", `/?room=${formatCode(clean)}`);
    scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    sessionStorage.removeItem("droplink-room");
    showToast(error.message, true);
  }
}

function leaveRoom() {
  disconnectEvents();
  clearInterval(state.countdownTimer);
  state.room = null;
  state.fileEntries.clear();
  sessionStorage.removeItem("droplink-room");
  roomView.hidden = true;
  landingView.hidden = false;
  history.replaceState({}, "", "/");
  $("#joinCodeInput").value = "";
  scrollTo({ top: 0, behavior: "smooth" });
}

$("#leaveRoomButton").onclick = leaveRoom;

function disconnectEvents() {
  if (state.source) state.source.close();
  state.source = null;
}

function connectEvents() {
  disconnectEvents();
  if (!state.room) return;
  const code = apiCode(state.room.code);
  const query = new URLSearchParams({ clientId: state.clientId, name: state.deviceName });
  state.source = new EventSource(`/api/rooms/${code}/events?${query}`);

  state.source.addEventListener("message", event => {
    try {
      const entry = JSON.parse(event.data);
      addStreamEntry(entry, true);
      if (entry.type === "file") addReceivedFile(entry, true);
    } catch {}
  });

  state.source.addEventListener("participants", event => {
    try { renderPeers(JSON.parse(event.data)); } catch {}
  });

  state.source.addEventListener("room-expired", () => {
    showToast("Время комнаты истекло", true);
    leaveRoom();
  });

  state.source.onerror = () => $("#networkLabel").textContent = "ПЕРЕПОДКЛЮЧЕНИЕ…";
  state.source.onopen = () => $("#networkLabel").textContent = "СОЕДИНЕНИЕ АКТИВНО";
}

function renderPeers(data) {
  const count = data.count || 0;
  $("#peerCount").textContent = `${count} ${count === 1 ? "устройство" : "устройства"}`;
  const peers = data.peers || [];
  $("#peerList").innerHTML = peers.length ? peers.map(peer => {
    const you = peer.clientId === state.clientId;
    return `<span class="peer-chip"><i></i><b>${escapeHtml(peer.name)}</b><small>${you ? "это устройство" : "подключено"}</small></span>`;
  }).join("") : `<span class="peer-chip"><i></i><b>${escapeHtml(state.deviceName)}</b><small>это устройство</small></span>`;
}

function getInviteBase() {
  return state.selectedLanUrl || state.info?.lanUrl || location.origin;
}

function buildInviteUrl() {
  const base = getInviteBase().replace(/\/$/, "");
  return `${base}/?room=${encodeURIComponent(formatCode(state.room.code))}`;
}

function renderInvite() {
  if (!state.room) return;
  const url = buildInviteUrl();
  $("#inviteUrl").textContent = url;
  const target = $("#qrCode");
  target.innerHTML = "";
  if (typeof QRCode !== "undefined") {
    new QRCode(target, {
      text: url, width: 250, height: 250,
      colorDark: "#0b1020", colorLight: "#ffffff",
      correctLevel: QRCode.CorrectLevel.M
    });
  }
  const selected = (state.info?.lanCandidates || []).find(item => item.url === state.selectedLanUrl);
  if (selected) $("#lanNote").textContent = `QR ведёт на ${selected.address} (${selected.interface}). Оба устройства должны быть в одной Wi‑Fi/LAN сети. Если телефон не открывает ссылку — запусти FIX_NETWORK_ACCESS.cmd один раз.`;
  else $("#lanNote").textContent = "LAN-адрес не найден. На телефоне localhost не откроется. Проверь подключение ПК к Wi‑Fi/Ethernet.";
}

$("#refreshQrButton").onclick = async () => {
  const button = $("#refreshQrButton");
  button.disabled = true;
  const old = button.textContent;
  button.textContent = "Сканирую…";
  await loadInfo({ preserveSelection: false });
  renderInvite();
  button.textContent = old;
  button.disabled = false;
  showToast("Сеть пересканирована, QR обновлён");
};

$("#copyCodeButton").onclick = () => copyText(formatCode(state.room?.code || ""));
$("#copyLinkButton").onclick = () => copyText(buildInviteUrl());

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast("Скопировано");
  } catch {
    const input = document.createElement("textarea");
    input.value = text;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    try { document.execCommand("copy"); showToast("Скопировано"); }
    catch { showToast("Не удалось скопировать", true); }
    input.remove();
  }
}

function startCountdown() {
  clearInterval(state.countdownTimer);
  const update = () => {
    if (!state.room) return;
    const diff = new Date(state.room.expiresAt).getTime() - Date.now();
    if (diff <= 0) { $("#roomExpiryText").textContent = "Комната истекла"; return; }
    const total = Math.floor(diff / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    $("#roomExpiryText").textContent = `Удалится через ${minutes}:${String(seconds).padStart(2, "0")}`;
  };
  update();
  state.countdownTimer = setInterval(update, 1000);
}

const messageInput = $("#messageInput");
messageInput.addEventListener("input", () => $("#charCount").textContent = messageInput.value.length);
messageInput.addEventListener("keydown", event => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") sendMessage();
});

async function sendMessage() {
  const text = messageInput.value.trim();
  if (!text || !state.room) return;
  const button = $("#sendMessageButton");
  button.disabled = true;
  try {
    const response = await fetch(`/api/rooms/${apiCode(state.room.code)}/messages`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, sender: state.deviceName, clientId: state.clientId })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Не удалось отправить");
    messageInput.value = "";
    $("#charCount").textContent = "0";
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; }
}

$("#sendMessageButton").onclick = sendMessage;
$("#clearMessageButton").onclick = () => { messageInput.value = ""; $("#charCount").textContent = "0"; messageInput.focus(); };
$("#pasteButton").onclick = async () => {
  try {
    messageInput.value = await navigator.clipboard.readText();
    $("#charCount").textContent = messageInput.value.length;
    messageInput.focus();
  } catch { showToast("Браузер не разрешил вставку", true); }
};

function renderHistory(messages) {
  const stream = $("#stream");
  stream.innerHTML = "";
  state.fileEntries.clear();

  if (!messages.length) {
    stream.innerHTML = `<div class="stream-empty" id="streamEmpty"><strong>История пока пустая</strong><span>Новые передачи появятся здесь автоматически.</span></div>`;
  } else {
    messages.forEach(entry => stream.appendChild(buildEntry(entry, false)));
  }

  const files = messages.filter(entry => entry.type === "file");
  renderReceivedFiles(files);
  if (messages.length) scrollStreamBottom(false);
}

function addStreamEntry(entry, animate) {
  $("#streamEmpty")?.remove();
  $("#stream").appendChild(buildEntry(entry, animate));
  scrollStreamBottom(true);
}

function buildEntry(entry, animate) {
  const element = document.createElement("article");
  element.className = `stream-entry ${entry.type === "file" ? "file" : "message"}${animate ? " entry-new" : ""}`;
  const time = new Date(entry.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const own = entry.clientId === state.clientId;
  const sender = own ? `${entry.sender} • вы` : entry.sender;

  if (entry.type === "file") {
    element.innerHTML = `<div class="entry-icon">↓</div><div class="entry-main"><div class="entry-meta"><b>${escapeHtml(sender)}</b><span>${escapeHtml(time)}</span></div><strong class="entry-title">${escapeHtml(entry.name)}</strong><span>${formatBytes(entry.size)} • файл</span></div><a class="entry-download" href="${fileUrl(entry)}" download>Скачать</a>`;
  } else {
    const text = String(entry.text || "");
    element.innerHTML = `<div class="entry-icon">T</div><div class="entry-main"><div class="entry-meta"><b>${escapeHtml(sender)}</b><span>${escapeHtml(time)}</span></div><div class="message-text">${linkify(text)}</div></div><div class="entry-buttons"><button type="button" data-copy="${encodeURIComponent(text)}">Копировать</button>${isUrl(text) ? `<a href="${escapeHtml(text)}" target="_blank" rel="noopener noreferrer">Открыть</a>` : ""}</div>`;
    $("[data-copy]", element).onclick = event => copyText(decodeURIComponent(event.currentTarget.dataset.copy));
  }
  return element;
}

function scrollStreamBottom(smooth = true) {
  const entries = $$(".stream-entry");
  entries.at(-1)?.scrollIntoView({ behavior: smooth ? "smooth" : "auto", block: "nearest" });
}
$("#scrollBottomButton").onclick = () => scrollStreamBottom(true);

function fileUrl(entry) {
  return `/api/rooms/${apiCode(state.room.code)}/files/${encodeURIComponent(entry.id)}`;
}

function renderReceivedFiles(files) {
  const root = $("#receivedFiles");
  root.innerHTML = "";
  state.fileEntries.clear();
  if (!files.length) {
    root.innerHTML = `<div class="files-empty" id="filesEmpty"><div class="files-empty-icon">↓</div><div><strong>Здесь появятся полученные файлы</strong><span>На другом устройстве выбери файл — он сразу появится здесь.</span></div></div>`;
  } else {
    files.forEach(entry => addReceivedFile(entry, false));
  }
  updateReceivedSummary();
}

function addReceivedFile(entry, fresh) {
  if (state.fileEntries.has(entry.id)) return;
  state.fileEntries.set(entry.id, entry);
  $("#filesEmpty")?.remove();

  const card = document.createElement("article");
  card.className = `received-file${fresh ? " fresh" : ""}`;
  card.dataset.fileId = entry.id;
  const own = entry.clientId === state.clientId;
  const time = new Date(entry.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  card.innerHTML = `<div class="file-badge">${fileExtension(entry.name)}</div><div class="received-file-main"><strong title="${escapeHtml(entry.name)}">${escapeHtml(entry.name)}</strong><span>${formatBytes(entry.size)} • ${escapeHtml(own ? "отправлено с этого устройства" : `от ${entry.sender}`)} • ${time}</span></div><a class="file-download-button" href="${fileUrl(entry)}" download>Скачать <b>↓</b></a>`;
  $("#receivedFiles").prepend(card);
  updateReceivedSummary();

  if (fresh && !own && $("#autoDownloadToggle").checked) {
    setTimeout(() => {
      triggerDownload(entry);
      showToast(`Получен файл: ${entry.name}`);
    }, 250);
  }
}

function fileExtension(name) {
  const ext = String(name || "").split(".").pop();
  if (!ext || ext === name || ext.length > 5) return "FILE";
  return ext.toUpperCase();
}

function updateReceivedSummary() {
  const files = [...state.fileEntries.values()];
  const total = files.reduce((sum, item) => sum + Number(item.size || 0), 0);
  $("#receivedSummary").textContent = files.length ? `${files.length} файл${files.length === 1 ? "" : "а"} • ${formatBytes(total)}` : "Пока файлов нет";
  $("#downloadAllButton").disabled = files.length === 0;
}

function triggerDownload(entry) {
  const link = document.createElement("a");
  link.href = fileUrl(entry);
  link.download = entry.name || "file";
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  setTimeout(() => link.remove(), 1000);
}

$("#downloadAllButton").onclick = () => {
  if (!state.fileEntries.size || !state.room) return;
  const link = document.createElement("a");
  link.href = `/api/rooms/${apiCode(state.room.code)}/files.zip`;
  link.download = `DropLink-${formatCode(state.room.code)}-files.zip`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  showToast("Собираю файлы комнаты в один ZIP");
};

const autoDownloadToggle = $("#autoDownloadToggle");
autoDownloadToggle.checked = localStorage.getItem("droplink-auto-download") === "1";
autoDownloadToggle.onchange = () => {
  localStorage.setItem("droplink-auto-download", autoDownloadToggle.checked ? "1" : "0");
  showToast(autoDownloadToggle.checked ? "Автозагрузка включена" : "Автозагрузка выключена");
};

const fileInput = $("#fileInput");
const dropZone = $("#fileDropZone");

fileInput.onchange = () => queueFiles([...fileInput.files]);
["dragenter", "dragover"].forEach(type => dropZone.addEventListener(type, event => {
  event.preventDefault();
  dropZone.classList.add("dragover");
}));
["dragleave", "drop"].forEach(type => dropZone.addEventListener(type, event => {
  event.preventDefault();
  dropZone.classList.remove("dragover");
}));
dropZone.addEventListener("drop", event => queueFiles([...event.dataTransfer.files]));

function queueFiles(files) {
  if (!files.length || !state.room) return;
  const limit = Number(state.info?.limits?.fileMb || 256) * 1024 * 1024;
  const valid = [];
  for (const file of files) {
    if (file.size > limit) showToast(`${file.name}: больше ${state.info?.limits?.fileMb || 256} МБ`, true);
    else valid.push(file);
  }
  state.pendingFiles.push(...valid);
  fileInput.value = "";
  processUploadQueue();
}

async function processUploadQueue() {
  if (state.uploadBusy || !state.pendingFiles.length) return;
  state.uploadBusy = true;
  const queueBox = $("#uploadQueue");
  queueBox.hidden = false;

  while (state.pendingFiles.length && state.room) {
    const file = state.pendingFiles.shift();
    try { await uploadSingleFile(file, state.pendingFiles.length); }
    catch (error) { showToast(error.message || `Не удалось отправить ${file.name}`, true); }
  }

  state.uploadBusy = false;
  $("#uploadStatus").textContent = "Готово";
  setTimeout(() => { if (!state.uploadBusy) queueBox.hidden = true; }, 900);
}

function uploadSingleFile(file, remaining) {
  return new Promise((resolve, reject) => {
    $("#uploadName").textContent = file.name;
    $("#uploadStatus").textContent = remaining ? `После него ещё ${remaining}` : "Отправка…";
    $("#uploadPercent").textContent = "0%";
    $("#uploadBar").style.width = "0%";

    const xhr = new XMLHttpRequest();
    xhr.open("POST", `/api/rooms/${apiCode(state.room.code)}/files`);
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.setRequestHeader("X-File-Type", file.type || "application/octet-stream");
    xhr.setRequestHeader("X-Sender", encodeURIComponent(state.deviceName));
    xhr.setRequestHeader("X-Client-Id", state.clientId);

    xhr.upload.onprogress = event => {
      if (!event.lengthComputable) return;
      const percent = Math.round((event.loaded / event.total) * 100);
      $("#uploadPercent").textContent = `${percent}%`;
      $("#uploadBar").style.width = `${percent}%`;
    };

    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText || "{}"); } catch {}
      if (xhr.status < 200 || xhr.status >= 300) return reject(new Error(data.error || `Ошибка ${xhr.status}`));
      $("#uploadPercent").textContent = "100%";
      $("#uploadBar").style.width = "100%";
      resolve(data);
    };
    xhr.onerror = () => reject(new Error("Соединение оборвалось во время передачи"));
    xhr.onabort = () => reject(new Error("Передача отменена"));
    xhr.send(file);
  });
}

async function boot() {
  await loadInfo();
  const params = new URLSearchParams(location.search);
  const requestedRoom = apiCode(params.get("room") || sessionStorage.getItem("droplink-room") || "");
  if (requestedRoom.length === 6) await enterRoom(requestedRoom);
}

window.addEventListener("pagehide", disconnectEvents);
boot();
