const { spawn, spawnSync } = require('child_process');
const path = require('path');
const readline = require('readline');

const PORT = Number(process.env.PORT || 3000);
const root = __dirname;

function ps(command) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });
  return { ok: r.status === 0, out: String(r.stdout || '').trim(), err: String(r.stderr || '').trim() };
}

function findWindowsPrimaryIp() {
  if (process.platform !== 'win32') return '';
  const cmd = String.raw`
$cfg = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
  Where-Object {
    $_.IPv4DefaultGateway -and $_.IPv4Address -and $_.NetAdapter.Status -eq 'Up' -and
    $_.IPv4Address.IPAddress -match '^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)' -and
    $_.InterfaceAlias -notmatch 'vEthernet|WSL|Docker|VirtualBox|VMware|Tailscale|ZeroTier|Hamachi|WireGuard|OpenVPN|Bluetooth|Loopback'
  } |
  Select-Object -First 1
if ($cfg) { $cfg.IPv4Address.IPAddress }
`;
  const r = ps(cmd);
  return r.ok ? r.out.split(/\r?\n/).map(s => s.trim()).find(Boolean) || '' : '';
}

function firewallRuleExists() {
  if (process.platform !== 'win32') return true;
  const name = `DropLink Local Transfer (TCP ${PORT})`;
  const safe = name.replace(/'/g, "''");
  return ps(`if(Get-NetFirewallRule -DisplayName '${safe}' -ErrorAction SilentlyContinue){exit 0}else{exit 1}`).ok;
}

function ask(question) {
  if (!process.stdin.isTTY) return Promise.resolve(true);
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      const a = String(answer || '').trim().toLowerCase();
      resolve(a === '' || a === 'y' || a === 'yes' || a === 'д' || a === 'да');
    });
  });
}

async function ensureFirewall() {
  if (process.platform !== 'win32' || firewallRuleExists()) return;
  console.log('');
  console.log('[DropLink] Windows Firewall ещё не настроен для телефона.');
  console.log(`[DropLink] Нужно один раз разрешить входящие подключения на TCP ${PORT} из частных LAN-сетей.`);
  const yes = await ask('Настроить сейчас? [Y/n]: ');
  if (!yes) {
    console.log('[DropLink] Пропущено. localhost будет работать, но телефон может не подключиться.');
    return;
  }
  const script = path.join(root, 'FIX_NETWORK_ACCESS.ps1');
  const r = spawnSync('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Port', String(PORT)
  ], { cwd: root, stdio: 'inherit' });
  if (r.status !== 0) console.log('[DropLink] Не удалось создать правило Firewall. Запусти FIX_NETWORK_ACCESS.cmd от администратора.');
}

async function main() {
  console.log('');
  console.log('========================================');
  console.log('  DropLink v0.2.2 — LAN startup check');
  console.log('========================================');

  await ensureFirewall();

  const env = { ...process.env, PORT: String(PORT) };
  const primaryIp = findWindowsPrimaryIp();
  if (primaryIp) {
    env.DROPLINK_PREFERRED_IP = primaryIp;
    console.log(`[DropLink] Основной LAN IP Windows: ${primaryIp}`);
  } else if (process.platform === 'win32') {
    console.log('[DropLink] Не удалось определить основной LAN IP через Windows. Сервер покажет все найденные адреса.');
  }

  console.log('');
  const child = spawn(process.execPath, [path.join(root, 'server.js')], {
    cwd: root,
    stdio: 'inherit',
    env
  });
  child.on('exit', code => process.exit(code ?? 0));

  const forward = signal => {
    try { child.kill(signal); } catch {}
  };
  process.once('SIGINT', () => forward('SIGINT'));
  process.once('SIGTERM', () => forward('SIGTERM'));
}

main().catch(err => {
  console.error('[DropLink] Ошибка запуска:', err && err.message ? err.message : err);
  process.exit(1);
});
