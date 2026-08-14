<div align="center">

# DropLink

> **v0.1.5 Hero Overlap Fix:** the decorative relay illustration no longer collides with the landing card on laptop and medium-width screens.

### `MOVE IT. DON'T MAIL IT.`

**Temporary rooms for instantly sharing text, links and small files between devices.**

<br>

![Version](https://img.shields.io/badge/version-0.1.5-A56CFF?style=for-the-badge&labelColor=10101C)
![Node](https://img.shields.io/badge/Node.js-18%2B-53E7FF?style=for-the-badge&labelColor=10101C)
![Realtime](https://img.shields.io/badge/realtime-SSE-FF76CB?style=for-the-badge&labelColor=10101C)
![License](https://img.shields.io/badge/license-MIT-BBFF64?style=for-the-badge&labelColor=10101C)

<br>

```text
CREATE  →  CONNECT  →  DROP  →  GONE
```

</div>

---

## ◉ SIGNAL / 00

```text
PRODUCT      DropLink
MODE         Temporary device relay
ROOM CODE    ABC-123
TRANSPORT    HTTP + Server-Sent Events
STORAGE      RAM only
ACCOUNT      Not required
DATABASE     Not required
FILE LIMIT   12 MB
ROOM TTL     10 / 30 / 60 min
```

DropLink — это маленький локальный relay-сервис для ситуаций, когда нужно быстро передать что-то между устройствами без лишних действий.

Например:

- ссылка с ПК → на телефон;
- текст с телефона → на ноутбук;
- небольшой файл → на другое устройство;
- кусок кода → на второй компьютер;
- временная заметка → в одну общую комнату.

Вместо:

```text
открыть мессенджер
→ найти самого себя
→ отправить файл
→ открыть второе устройство
→ снова открыть мессенджер
```

DropLink делает:

```text
CREATE DROP
→ SCAN QR
→ SEND
```

---

# 01 / CORE

## Что уже работает

| Возможность | Статус |
|---|:---:|
| Временные комнаты | ✅ |
| Код формата `ABC-123` | ✅ |
| Подключение по QR | ✅ |
| Подключение по коду | ✅ |
| Передача текста | ✅ |
| Передача ссылок | ✅ |
| Передача файлов | ✅ |
| Live room stream | ✅ |
| Список подключённых устройств | ✅ |
| Автоудаление комнаты | ✅ |
| 10 / 30 / 60 минут жизни | ✅ |
| LAN-адрес для телефона | ✅ |
| Выбор сетевого адаптера | ✅ |
| Повторное сканирование сети | ✅ |
| Мобильная версия | ✅ |
| База данных | ❌ не нужна |
| Аккаунт | ❌ не нужен |

---

# 02 / HOW IT FEELS

DropLink построен вокруг одной идеи:

> **Передача должна занимать меньше времени, чем решение “куда это себе отправить”.**

Комната создаётся за одно действие.

После этого пользователь получает:

```text
ROOM
A7K-3QX

[ QR CODE ]

expires in 29:59
```

На втором устройстве достаточно:

```text
SCAN QR
```

или:

```text
JOIN DROP
A7K-3QX
```

После подключения оба устройства видят одну общую ленту.

---

# 03 / QUICK START

## Требования

Нужен:

```text
Node.js 18+
```

Проверить установленную версию:

```bash
node -v
```

Пример:

```text
v22.18.0
```

---

## Запуск

Открой терминал в папке DropLink и выполни:

```bash
npm start
```

DropLink покажет два адреса:

```text
DropLink v0.1.4 is running

Local:   http://localhost:3000
Network: http://192.168.0.102:3000
```

### На компьютере

Открывай:

```text
http://localhost:3000
```

### На телефоне

Открывай именно:

```text
http://192.168.0.102:3000
```

Телефон и компьютер должны находиться **в одной локальной сети**.

---

# 04 / FIRST DROP

## 1. Создай комнату

Нажми:

```text
CREATE DROP
```

Выбери время жизни:

```text
10 MIN
30 MIN
60 MIN
```

---

## 2. Подключи второе устройство

Есть два варианта.

### QR

Отсканируй QR-код камерой телефона.

### Room Code

Введи код:

```text
A7K-3QX
```

---

## 3. Передавай

Можно отправлять:

```text
TEXT
LINK
FILE
```

Все подключённые устройства увидят новый элемент практически сразу.

---

# 05 / RELAY MAP

```text
┌─────────────────────┐
│      DEVICE A       │
│                     │
│  Windows / Android  │
└──────────┬──────────┘
           │
           │ POST
           ▼
     ┌───────────┐
     │ DropLink  │
     │   ROOM    │
     │  ABC-123  │
     └─────┬─────┘
           │
           │ SSE
           ▼
┌─────────────────────┐
│      DEVICE B       │
│                     │
│ Android / iOS / PC  │
└─────────────────────┘
```

Сообщения и файлы проходят через Node.js процесс, где временно находятся в памяти комнаты.

---

# 06 / REALTIME

Для live-обновлений используется:

```text
Server-Sent Events
SSE
```

Схема:

```text
DEVICE A
   │
   │ POST /messages
   ▼
SERVER
   │
   │ SSE event
   ├──────────────► DEVICE A
   ├──────────────► DEVICE B
   └──────────────► DEVICE C
```

Для текущей задачи это позволяет оставить проект лёгким и не подключать внешнюю WebSocket-библиотеку.

---

# 07 / QR + LOCAL NETWORK

Это одна из самых важных частей DropLink.

На Windows у компьютера может быть сразу несколько сетевых адресов:

```text
Wi-Fi
Ethernet
WSL
Hyper-V
Docker
VPN
VirtualBox
VMware
```

Не каждый из них доступен телефону.

Поэтому DropLink:

- ищет LAN-адаптеры;
- старается выбрать Wi-Fi / Ethernet;
- показывает найденный IP;
- позволяет вручную выбрать другой адрес;
- умеет пересканировать сеть;
- пересобирает QR под выбранный адрес.

Пример:

```text
NETWORK ADDRESS

★ 192.168.0.102 — Ethernet
  192.168.0.145 — Wi-Fi
```

---

## QR не открывается?

Проверяй по порядку.

### STEP 01

Скопируй Network URL из терминала:

```text
http://192.168.0.102:3000
```

Введи его **вручную** в браузере телефона.

Если он не открывается — проблема не в QR.

---

### STEP 02

Убедись, что:

```text
PC      → Home Wi-Fi
PHONE   → Home Wi-Fi
```

а не:

```text
PC      → Wi-Fi
PHONE   → Mobile Internet
```

---

### STEP 03

Проверь Windows Firewall.

При первом запуске Node.js Windows может показать окно:

> Разрешить приложению доступ к сети?

Нужно разрешить доступ хотя бы к:

```text
Private networks
```

---

### STEP 04

Если в DropLink несколько Network Address — попробуй другой.

Например:

```text
192.168.x.x
```

обычно предпочтительнее виртуальных адресов.

---

# 08 / FILE RELAY

Текущие лимиты:

```text
ONE FILE        12 MB
ROOM FILES      48 MB
ROOM HISTORY    120 entries
```

Файл хранится в памяти Node.js процесса.

После удаления комнаты он больше недоступен.

DropLink v0.1.4 не предназначен для:

```text
20 GB video
50 GB archive
large backups
```

Он предназначен для:

```text
image
document
small archive
code file
config
screenshot
quick transfer
```

---

# 09 / EPHEMERAL MODEL

DropLink не использует постоянную базу данных.

```text
CREATE ROOM
     │
     ▼
┌──────────────┐
│ SERVER RAM   │
│              │
│ messages     │
│ files        │
│ devices      │
└──────┬───────┘
       │
       │ TTL expired
       ▼
    DELETED
```

Комната исчезнет, если:

- закончился таймер;
- сервер был остановлен;
- Node.js был перезапущен.

---

# 10 / PRIVACY

## Что DropLink не делает

В текущем проекте нет:

```text
USER ACCOUNTS
PROFILE DATABASE
ANALYTICS DATABASE
PERMANENT MESSAGE HISTORY
CLOUD STORAGE
```

## Что важно понимать

DropLink v0.1.4 — это **relay**, а не P2P E2E messenger.

При локальном запуске:

```text
DEVICE
   │
   ▼
YOUR COMPUTER
   │
   ▼
DEVICE
```

При размещении на удалённом сервере:

```text
DEVICE
   │
   ▼
REMOTE SERVER
   │
   ▼
DEVICE
```

То есть владелец сервера технически контролирует среду, через которую проходят данные.

End-to-end encryption пока не реализовано.

---

# 11 / PROJECT STRUCTURE

```text
DropLink/
│
├── public/
│   ├── index.html
│   ├── styles.css
│   ├── app.js
│   ├── qrcode.min.js
│   └── favicon.svg
│
├── server.js
├── package.json
├── README.md
├── LICENSE
├── qrcodejs-LICENSE.txt
└── .gitignore
```

---

## `public/index.html`

Основная разметка интерфейса.

---

## `public/styles.css`

Визуальная система DropLink:

```text
violet
cyan
glass surfaces
device relay visual
room stream
adaptive layout
large typography
```

---

## `public/app.js`

Frontend отвечает за:

- создание комнаты;
- подключение;
- QR;
- countdown;
- SSE;
- room stream;
- отправку текста;
- upload progress;
- скачивание файлов;
- список устройств;
- выбор LAN-адреса;
- пересканирование сети.

---

## `server.js`

Backend отвечает за:

- генерацию комнат;
- короткие коды;
- TTL;
- память комнаты;
- SSE clients;
- сообщения;
- файлы;
- очистку комнат;
- LAN discovery;
- rate limiting.

---

# 12 / API SIGNALS

## Create room

```http
POST /api/rooms
```

```json
{
  "ttlMinutes": 30
}
```

---

## Get room

```http
GET /api/rooms/ABC123
```

---

## Live events

```http
GET /api/rooms/ABC123/events
```

---

## Send text

```http
POST /api/rooms/ABC123/messages
```

```json
{
  "text": "https://example.com",
  "sender": "Windows PC",
  "clientId": "..."
}
```

---

## Upload file

```http
POST /api/rooms/ABC123/files
```

Файл передаётся как raw request body.

---

## Download file

```http
GET /api/rooms/ABC123/files/FILE_ID
```

---

# 13 / NO INSTALL CHAOS

DropLink специально сделан без внешних Node.js зависимостей.

Поэтому:

```bash
npm install
```

в текущей версии не требуется.

Достаточно:

```bash
npm start
```

QR-библиотека уже лежит локально внутри проекта.

---

# 14 / DEVELOPMENT

Обычный режим:

```bash
npm start
```

Development mode с автоматическим restart:

```bash
npm run dev
```

---

# 15 / GITHUB

Рекомендуемое название репозитория:

```text
DropLink
```

Описание:

```text
Temporary rooms for instantly sharing text, links and small files between devices.
```

При создании репозитория **не нужно дополнительно создавать**:

```text
README.md
LICENSE
.gitignore
```

Они уже находятся в проекте.

---

## Upload через сайт GitHub

1. Создай новый repository.
2. Открой его.
3. Нажми `Add file`.
4. Выбери `Upload files`.
5. Перетащи **содержимое папки DropLink**.
6. Нажми `Commit changes`.

В корне репозитория должно быть:

```text
public/
server.js
package.json
README.md
LICENSE
.gitignore
```

Не загружай только ZIP как единственный файл репозитория.

---

# 16 / GITHUB PAGES

Полноценный DropLink не может работать только через GitHub Pages.

Причина:

```text
GitHub Pages
    =
static hosting


DropLink
    =
frontend
+
Node.js relay server
```

GitHub подходит для хранения исходного кода.

Для живой версии понадобится Node.js hosting.

---

# 17 / COMMON ISSUES

<details>
<summary><strong>npm или node не найдены</strong></summary>

Проверь:

```bash
node -v
npm -v
```

Если команды отсутствуют — установи Node.js и перезапусти терминал.

</details>

<details>
<summary><strong>localhost работает, а телефон не подключается</strong></summary>

Используй Network URL:

```text
http://192.168.x.x:3000
```

а не:

```text
http://localhost:3000
```

`localhost` на телефоне означает **сам телефон**, а не компьютер.

</details>

<details>
<summary><strong>QR ведёт на недоступный адрес</strong></summary>

В комнате открой:

```text
NETWORK ADDRESS
```

и выбери другой LAN-адаптер.

После этого QR будет пересобран.

</details>

<details>
<summary><strong>Windows блокирует подключение</strong></summary>

Разреши Node.js доступ к:

```text
Private networks
```

в Windows Firewall.

</details>

<details>
<summary><strong>Комната внезапно исчезла</strong></summary>

Это ожидаемое поведение.

Комнаты временные и удаляются:

- после окончания TTL;
- после остановки сервера;
- после restart Node.js.

</details>

<details>
<summary><strong>Нужен другой порт</strong></summary>

### CMD

```bat
set PORT=8080 && npm start
```

### PowerShell

```powershell
$env:PORT=8080
npm start
```

После этого:

```text
http://localhost:8080
```

</details>

---

# 18 / CURRENT LIMITS

DropLink v0.1.4 пока не имеет:

- постоянных комнат;
- аккаунтов;
- room PIN;
- end-to-end encryption;
- WebRTC P2P;
- multi-file drag & drop;
- image clipboard paste;
- постоянной истории;
- Redis;
- multi-server synchronization.

Это не случайность.

Текущая цель проекта:

> **Сделать маленький relay, который легко понять, запустить и реально использовать.**

---

# 19 / ROADMAP

```text
┌──────────────────────────────────────┐
│ DROP/LINK — NEXT SIGNALS            │
├──────────────────────────────────────┤
│ [ ] Optional room PIN               │
│ [ ] WebRTC P2P                      │
│ [ ] End-to-end encryption           │
│ [ ] Multiple files                  │
│ [ ] Image preview                   │
│ [ ] Paste images from clipboard     │
│ [ ] PWA mode                        │
│ [ ] Better transfer progress        │
│ [ ] Room owner controls             │
│ [ ] Redis adapter                   │
└──────────────────────────────────────┘
```

---

# 20 / DESIGN LANGUAGE

В отличие от других utility-проектов, DropLink использует собственное визуальное направление:

```text
DARK
VIOLET
CYAN
GLASS
RELAY
SIGNAL
DEVICE-TO-DEVICE
```

Интерфейс строится вокруг ощущения:

> **двух устройств и сигнала между ними.**

---

# 21 / QR CODE

QR generation uses **QRCode.js** by davidshimjs.

Лицензия библиотеки находится в:

```text
qrcodejs-LICENSE.txt
```

---

# 22 / LICENSE

DropLink распространяется под лицензией:

```text
MIT
```

Полный текст:

```text
LICENSE
```

---

<div align="center">

<br>

```text
╭──────────────────────────────────────╮
│                                      │
│              DROPLINK                │
│                                      │
│       CREATE • CONNECT • DROP        │
│                                      │
╰──────────────────────────────────────╯
```

### `NO ACCOUNT / TEMPORARY / FAST`

**CayPlayProjects · 2026**

</div>
