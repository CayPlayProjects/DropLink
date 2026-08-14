const $ = (selector, root=document) => root.querySelector(selector);
const $$ = (selector, root=document) => [...root.querySelectorAll(selector)];

const state = {
  room:null,
  source:null,
  ttl:30,
  info:null,
  selectedLanUrl:null,
  clientId:getClientId(),
  deviceName:getDeviceName(),
  countdownTimer:null
};

const landingView = $("#landingView");
const roomView = $("#roomView");
const toast = $("#toast");
const toastText = $("#toastText");
let toastTimer = null;

function getClientId(){
  let id = sessionStorage.getItem("droplink-client");
  if(!id){
    id = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    sessionStorage.setItem("droplink-client", id);
  }
  return id;
}

function getDeviceName(){
  const ua = navigator.userAgent || "";
  if(/iPhone/i.test(ua)) return "iPhone";
  if(/iPad/i.test(ua)) return "iPad";
  if(/Android/i.test(ua)) return "Android";
  if(/Windows/i.test(ua)) return "Windows PC";
  if(/Macintosh|Mac OS X/i.test(ua)) return "Mac";
  if(/Linux/i.test(ua)) return "Linux device";
  return "Browser";
}

function showToast(message, error=false){
  toastText.textContent = message;
  toast.classList.toggle("error", error);
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2200);
}

function formatCode(raw){
  const clean = String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,6);
  return clean.length > 3 ? `${clean.slice(0,3)}-${clean.slice(3)}` : clean;
}

function apiCode(code){
  return String(code || "").toUpperCase().replace(/[^A-Z0-9]/g,"");
}

function escapeHtml(value){
  return String(value ?? "")
    .replaceAll("&","&amp;")
    .replaceAll("<","&lt;")
    .replaceAll(">","&gt;")
    .replaceAll('"',"&quot;")
    .replaceAll("'","&#039;");
}

function formatBytes(bytes){
  if(bytes < 1024) return `${bytes} B`;
  if(bytes < 1024*1024) return `${(bytes/1024).toFixed(1)} KB`;
  return `${(bytes/1024/1024).toFixed(2)} MB`;
}

function isUrl(text){
  try{
    const value = String(text).trim();
    if(!/^https?:\/\//i.test(value)) return false;
    new URL(value);
    return true;
  }catch{
    return false;
  }
}

function linkify(text){
  const escaped = escapeHtml(text);
  const regex = /(https?:\/\/[^\s<]+)/gi;
  return escaped.replace(regex, url => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
}

function switchDeck(mode){
  const create = mode === "create";
  $("#createTab").classList.toggle("active", create);
  $("#joinTab").classList.toggle("active", !create);
  $("#createTab").setAttribute("aria-selected", String(create));
  $("#joinTab").setAttribute("aria-selected", String(!create));
  $("#createPanel").classList.toggle("active", create);
  $("#joinPanel").classList.toggle("active", !create);
  if(!create) setTimeout(() => $("#joinCodeInput").focus(), 80);
}

$("#createTab").onclick = () => switchDeck("create");
$("#joinTab").onclick = () => switchDeck("join");

$$("[data-ttl]").forEach(button => {
  button.onclick = () => {
    state.ttl = Number(button.dataset.ttl);
    $$("[data-ttl]").forEach(b => b.classList.toggle("active", b === button));
  };
});

$("#joinCodeInput").addEventListener("input", event => {
  const formatted = formatCode(event.target.value);
  event.target.value = formatted;
});
$("#joinCodeInput").addEventListener("keydown", event => {
  if(event.key === "Enter") joinRequestedRoom();
});

async function loadInfo({preserveSelection=true} = {}){
  try{
    const previous = preserveSelection ? state.selectedLanUrl : null;
    const response = await fetch(`/api/info?ts=${Date.now()}`, {cache:"no-store"});
    state.info = await response.json();

    const candidates = state.info.lanCandidates || [];
    const stillExists = previous && candidates.some(item => item.url === previous);

    state.selectedLanUrl = stillExists
      ? previous
      : (candidates[0]?.url || state.info.lanUrl || state.info.origin || window.location.origin);

    if(candidates.length){
      $("#networkLabel").textContent = "LAN RELAY READY";
    }else{
      $("#networkLabel").textContent = "LOCAL ONLY";
    }

    renderNetworkOptions();
  }catch{
    $("#networkLabel").textContent = "NETWORK UNKNOWN";
  }
}

function renderNetworkOptions(){
  const select = $("#networkSelect");
  if(!select || !state.info) return;

  const candidates = state.info.lanCandidates || [];
  select.innerHTML = "";

  if(candidates.length){
    for(const item of candidates){
      const option = document.createElement("option");
      option.value = item.url;
      option.textContent = `${item.recommended ? "★ " : ""}${item.address} — ${item.interface}`;
      select.appendChild(option);
    }
  }else{
    const option = document.createElement("option");
    option.value = state.info.origin || window.location.origin;
    option.textContent = "Localhost only — LAN IP not found";
    select.appendChild(option);
  }

  select.value = state.selectedLanUrl || select.options[0]?.value || "";

  select.onchange = () => {
    state.selectedLanUrl = select.value;
    renderInvite();
    showToast("QR переключён на выбранную сеть");
  };
}

async function createRoom(){
  const button = $("#createRoomButton");
  button.disabled = true;

  try{
    const response = await fetch("/api/rooms", {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({ttlMinutes:state.ttl})
    });
    const data = await response.json();
    if(!response.ok) throw new Error(data.error || "Не удалось создать комнату");
    await enterRoom(data.code);
  }catch(error){
    showToast(error.message, true);
  }finally{
    button.disabled = false;
  }
}

async function joinRequestedRoom(){
  const code = apiCode($("#joinCodeInput").value);
  if(code.length !== 6){
    showToast("Введите полный код комнаты", true);
    return;
  }
  await enterRoom(code);
}

$("#createRoomButton").onclick = createRoom;
$("#joinRoomButton").onclick = joinRequestedRoom;

async function enterRoom(code){
  try{
    const clean = apiCode(code);
    const response = await fetch(`/api/rooms/${encodeURIComponent(clean)}`);
    const data = await response.json();
    if(!response.ok) throw new Error(data.error || "Комната не найдена");

    state.room = data;
    sessionStorage.setItem("droplink-room", clean);

    landingView.hidden = true;
    roomView.hidden = false;
    $("#roomCodeTitle").textContent = formatCode(clean);

    renderHistory(data.messages || []);
    renderInvite();
    startCountdown();
    connectEvents();

    window.history.replaceState({}, "", `/?room=${formatCode(clean)}`);
    window.scrollTo({top:0, behavior:"smooth"});
  }catch(error){
    showToast(error.message, true);
  }
}

function leaveRoom(){
  disconnectEvents();
  clearInterval(state.countdownTimer);
  state.room = null;
  sessionStorage.removeItem("droplink-room");
  roomView.hidden = true;
  landingView.hidden = false;
  window.history.replaceState({}, "", "/");
  $("#joinCodeInput").value = "";
  window.scrollTo({top:0, behavior:"smooth"});
}

$("#leaveRoomButton").onclick = leaveRoom;

function disconnectEvents(){
  if(state.source){
    state.source.close();
    state.source = null;
  }
}

function connectEvents(){
  disconnectEvents();
  if(!state.room) return;

  const code = apiCode(state.room.code);
  const query = new URLSearchParams({
    clientId:state.clientId,
    name:state.deviceName
  });

  state.source = new EventSource(`/api/rooms/${code}/events?${query.toString()}`);

  state.source.addEventListener("message", event => {
    const entry = JSON.parse(event.data);
    addStreamEntry(entry, true);
  });

  state.source.addEventListener("participants", event => {
    const data = JSON.parse(event.data);
    renderPeers(data);
  });

  state.source.addEventListener("room-expired", () => {
    showToast("Время комнаты истекло", true);
    leaveRoom();
  });

  state.source.onerror = () => {
    $("#networkLabel").textContent = "RECONNECTING…";
  };

  state.source.onopen = () => {
    $("#networkLabel").textContent = "RELAY CONNECTED";
  };
}

function renderPeers(data){
  const count = data.count || 0;
  $("#peerCount").textContent = `${count} ${count === 1 ? "DEVICE" : "DEVICES"}`;
  const peers = data.peers || [];
  $("#peerList").innerHTML = peers.length
    ? peers.map(peer => {
        const you = peer.clientId === state.clientId;
        return `<span class="peer-chip"><i></i>${escapeHtml(peer.name)}${you ? " • you" : ""}</span>`;
      }).join("")
    : `<span class="peer-chip"><i></i>${escapeHtml(state.deviceName)} • you</span>`;
}

function getInviteBase(){
  if(state.selectedLanUrl) return state.selectedLanUrl;
  if(state.info?.lanUrl) return state.info.lanUrl;
  return window.location.origin;
}

function buildInviteUrl(){
  const base = getInviteBase().replace(/\/$/,"");
  return `${base}/?room=${encodeURIComponent(formatCode(state.room.code))}`;
}

function renderInvite(){
  if(!state.room) return;
  const url = buildInviteUrl();
  $("#inviteUrl").textContent = url;
  const target = $("#qrCode");
  target.innerHTML = "";

  if(typeof QRCode !== "undefined"){
    new QRCode(target, {
      text:url,
      width:280,
      height:280,
      colorDark:"#080812",
      colorLight:"#f9f7ff",
      correctLevel:QRCode.CorrectLevel.M
    });
  }

  const usingLan = Boolean(state.selectedLanUrl && state.selectedLanUrl !== state.info?.origin);
  const selected = (state.info?.lanCandidates || []).find(item => item.url === state.selectedLanUrl);

  if(usingLan && selected){
    $("#lanNote").textContent =
      `QR → ${selected.address} (${selected.interface}). Если телефон не открывает ссылку, выбери другой адрес выше.`;
  }else if(usingLan){
    $("#lanNote").textContent =
      "QR использует локальный адрес компьютера. Телефон должен быть в той же Wi‑Fi сети.";
  }else{
    $("#lanNote").textContent =
      "LAN-адрес не найден. На телефоне localhost работать не будет.";
  }
}

$("#refreshQrButton").onclick = async () => {
  const button = $("#refreshQrButton");
  const oldText = button.textContent;
  button.disabled = true;
  button.textContent = "SCANNING…";

  const previous = state.selectedLanUrl;
  await loadInfo({preserveSelection:true});
  renderInvite();

  button.textContent = oldText;
  button.disabled = false;

  const changed = previous !== state.selectedLanUrl;
  showToast(changed ? "Найден новый сетевой адрес" : "Сеть пересканирована • QR пересобран");
};

$("#copyCodeButton").onclick = () => copyText(formatCode(state.room?.code || ""));
$("#copyLinkButton").onclick = () => copyText(buildInviteUrl());

async function copyText(text){
  try{
    await navigator.clipboard.writeText(text);
    showToast("Скопировано");
  }catch{
    showToast("Браузер не разрешил копирование", true);
  }
}

function startCountdown(){
  clearInterval(state.countdownTimer);
  const update = () => {
    if(!state.room) return;
    const diff = new Date(state.room.expiresAt).getTime() - Date.now();

    if(diff <= 0){
      $("#roomExpiryText").textContent = "Room expired";
      return;
    }

    const total = Math.floor(diff / 1000);
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    $("#roomExpiryText").textContent = `Room expires in ${minutes}:${String(seconds).padStart(2,"0")}`;
  };

  update();
  state.countdownTimer = setInterval(update, 1000);
}

const messageInput = $("#messageInput");
messageInput.addEventListener("input", () => {
  $("#charCount").textContent = messageInput.value.length;
});
messageInput.addEventListener("keydown", event => {
  if((event.ctrlKey || event.metaKey) && event.key === "Enter"){
    sendMessage();
  }
});

async function sendMessage(){
  const text = messageInput.value.trim();
  if(!text || !state.room) return;

  const button = $("#sendMessageButton");
  button.disabled = true;

  try{
    const response = await fetch(`/api/rooms/${apiCode(state.room.code)}/messages`, {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({
        text,
        sender:state.deviceName,
        clientId:state.clientId
      })
    });
    const data = await response.json();
    if(!response.ok) throw new Error(data.error || "Не удалось отправить");
    messageInput.value = "";
    $("#charCount").textContent = "0";
    messageInput.focus();
  }catch(error){
    showToast(error.message, true);
  }finally{
    button.disabled = false;
  }
}

$("#sendMessageButton").onclick = sendMessage;
$("#clearMessageButton").onclick = () => {
  messageInput.value = "";
  $("#charCount").textContent = "0";
  messageInput.focus();
};
$("#pasteButton").onclick = async () => {
  try{
    messageInput.value = await navigator.clipboard.readText();
    $("#charCount").textContent = messageInput.value.length;
    messageInput.focus();
  }catch{
    showToast("Браузер не разрешил вставку", true);
  }
};

function renderHistory(messages){
  const stream = $("#stream");
  stream.innerHTML = "";

  if(!messages.length){
    stream.innerHTML = `
      <div class="stream-empty" id="streamEmpty">
        <div class="empty-orbit"><span></span></div>
        <strong>Пока здесь пусто</strong>
        <p>Отправь первую ссылку, текст или файл — он появится на всех подключённых устройствах.</p>
      </div>`;
    return;
  }

  for(const entry of messages){
    stream.appendChild(buildEntry(entry, false));
  }
  scrollStreamBottom();
}

function addStreamEntry(entry, animate){
  const empty = $("#streamEmpty");
  if(empty) empty.remove();

  const element = buildEntry(entry, animate);
  $("#stream").appendChild(element);
  scrollStreamBottom();
}

function buildEntry(entry, animate){
  const element = document.createElement("article");
  element.className = `stream-entry ${entry.type === "file" ? "file" : "message"}${animate ? " entry-new" : ""}`;

  const time = new Date(entry.createdAt).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"});
  const own = entry.clientId === state.clientId;
  const sender = own ? `${entry.sender} • you` : entry.sender;

  if(entry.type === "file"){
    element.innerHTML = `
      <div class="entry-icon">F</div>
      <div class="entry-content">
        <div class="entry-meta"><b>${escapeHtml(sender)}</b><span>${escapeHtml(time)}</span></div>
        <div class="file-title">${escapeHtml(entry.name)}</div>
        <div class="file-sub">${escapeHtml(formatBytes(entry.size))} • ${escapeHtml(entry.mime || "application/octet-stream")}</div>
      </div>
      <div class="entry-actions">
        <a href="/api/rooms/${apiCode(state.room.code)}/files/${encodeURIComponent(entry.id)}" download>GET</a>
      </div>`;
  }else{
    const text = String(entry.text || "");
    const openButton = isUrl(text)
      ? `<a href="${escapeHtml(text)}" target="_blank" rel="noopener noreferrer">OPEN</a>`
      : "";

    element.innerHTML = `
      <div class="entry-icon">T</div>
      <div class="entry-content">
        <div class="entry-meta"><b>${escapeHtml(sender)}</b><span>${escapeHtml(time)}</span></div>
        <div class="message-text">${linkify(text)}</div>
      </div>
      <div class="entry-actions">
        <button type="button" data-copy="${encodeURIComponent(text)}">COPY</button>
        ${openButton}
      </div>`;

    const copyButton = $("[data-copy]", element);
    if(copyButton){
      copyButton.onclick = () => copyText(decodeURIComponent(copyButton.dataset.copy));
    }
  }

  return element;
}

function scrollStreamBottom(){
  const entries = $$(".stream-entry");
  entries.at(-1)?.scrollIntoView({behavior:"smooth",block:"nearest"});
}
$("#scrollBottomButton").onclick = scrollStreamBottom;

const fileInput = $("#fileInput");
const dropZone = $("#fileDropZone");

fileInput.onchange = () => {
  if(fileInput.files[0]) uploadFile(fileInput.files[0]);
};

["dragenter","dragover"].forEach(type => {
  dropZone.addEventListener(type, event => {
    event.preventDefault();
    dropZone.classList.add("dragover");
  });
});
["dragleave","drop"].forEach(type => {
  dropZone.addEventListener(type, event => {
    event.preventDefault();
    dropZone.classList.remove("dragover");
  });
});
dropZone.addEventListener("drop", event => {
  const file = event.dataTransfer.files[0];
  if(file) uploadFile(file);
});

function uploadFile(file){
  if(!state.room) return;
  if(file.size > 12 * 1024 * 1024){
    showToast("Максимальный размер файла — 12 MB", true);
    return;
  }

  const progress = $("#uploadProgress");
  progress.hidden = false;
  $("#uploadName").textContent = file.name;
  $("#uploadPercent").textContent = "0%";
  $("#uploadBar").style.width = "0%";

  const xhr = new XMLHttpRequest();
  xhr.open("POST", `/api/rooms/${apiCode(state.room.code)}/files`);
  xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
  xhr.setRequestHeader("X-File-Type", file.type || "application/octet-stream");
  xhr.setRequestHeader("X-Sender", encodeURIComponent(state.deviceName));
  xhr.setRequestHeader("X-Client-Id", state.clientId);

  xhr.upload.onprogress = event => {
    if(!event.lengthComputable) return;
    const percent = Math.round((event.loaded / event.total) * 100);
    $("#uploadPercent").textContent = `${percent}%`;
    $("#uploadBar").style.width = `${percent}%`;
  };

  xhr.onload = () => {
    try{
      const data = JSON.parse(xhr.responseText || "{}");
      if(xhr.status < 200 || xhr.status >= 300){
        throw new Error(data.error || "Не удалось загрузить файл");
      }
      $("#uploadPercent").textContent = "100%";
      $("#uploadBar").style.width = "100%";
      showToast("Файл отправлен");
    }catch(error){
      showToast(error.message, true);
    }finally{
      setTimeout(() => { progress.hidden = true; }, 650);
      fileInput.value = "";
    }
  };

  xhr.onerror = () => {
    showToast("Ошибка передачи файла", true);
    progress.hidden = true;
  };

  xhr.send(file);
}

async function boot(){
  await loadInfo();

  const params = new URLSearchParams(location.search);
  const requestedRoom = apiCode(params.get("room") || sessionStorage.getItem("droplink-room") || "");

  if(requestedRoom.length === 6){
    await enterRoom(requestedRoom);
  }
}

boot();
