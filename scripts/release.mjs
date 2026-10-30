#!/usr/bin/env node
// PhotoEdit — интерактивная сборка подписанного и нотаризованного приложения для macOS.
//
//   npm run release              — спросит всё по шагам
//   npm run release -- --yes     — взять сохранённые ответы, спросить только секреты
//   npm run release -- --dry-run — показать план и команды, ничего не выполняя
//
// Секреты (пароли, ключи) никогда не сохраняются. В .release.json (в .gitignore)
// пишутся только ответы вроде Bundle ID, сертификата и способа нотаризации.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TAURI = path.join(ROOT, 'src-tauri');
const SETTINGS = path.join(ROOT, '.release.json');
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const YES = args.has('--yes') || args.has('-y');

if (args.has('-h') || args.has('--help')) {
  console.log(`Сборка PhotoEdit для macOS

  npm run release              интерактивно
  npm run release -- --yes     использовать сохранённые ответы
  npm run release -- --dry-run показать план без выполнения`);
  process.exit(0);
}

// cargo из rustup может не быть в PATH у GUI-терминалов
process.env.PATH = `${path.join(os.homedir(), '.cargo', 'bin')}:${process.env.PATH}`;

// ---------- вывод ----------

const tty = process.stdout.isTTY;
const c = (code) => (s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const bold = c('1'), dim = c('2'), red = c('31'), green = c('32'), yellow = c('33'), cyan = c('36');

const step = (n, title) => console.log(`\n${cyan(bold(`[${n}]`))} ${bold(title)}`);
const info = (s) => console.log(`    ${s}`);
const ok = (s) => console.log(`    ${green('✓')} ${s}`);
const warn = (s) => console.log(`    ${yellow('!')} ${s}`);
const fail = (s) => {
  console.error(`\n${red('✗')} ${s}`);
  process.exit(1);
};

// ---------- ввод ----------

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
let muted = false;
const origWrite = rl._writeToOutput.bind(rl);
rl._writeToOutput = (s) => {
  // при вводе секрета эхо подавляется, но перевод строки показываем
  if (!muted) return origWrite(s);
  if (s.includes('\n') || s.includes('\r')) origWrite('\n');
};

// очередь строк: при вводе через pipe readline читает всё сразу, и rl.question терял бы ответы
const pending = [];
let waiter = null;
let inputClosed = false;
rl.on('line', (l) => {
  if (waiter) {
    const w = waiter;
    waiter = null;
    w(l);
  } else pending.push(l);
});
rl.on('close', () => {
  inputClosed = true;
  if (waiter) waiter(null);
});

function question(q, { secret = false } = {}) {
  rl.setPrompt(q);
  rl.prompt();
  muted = secret;
  return new Promise((resolve) => {
    const done = (v) => {
      muted = false;
      if (v === null) fail('Ввод закончился раньше, чем были заданы все вопросы');
      resolve(v);
    };
    if (pending.length) done(pending.shift());
    else if (inputClosed) done(null);
    else waiter = done;
  });
}

async function ask(label, def = '', { required = true, validate } = {}) {
  for (;;) {
    const v = (await question(`    ${label}${def ? dim(` [${def}]`) : ''}: `)).trim() || def;
    if (!v && required) {
      warn('Нужно значение');
      continue;
    }
    const err = validate?.(v);
    if (err) {
      warn(err);
      continue;
    }
    return v;
  }
}

async function askSecret(label) {
  return (await question(`    ${label}: `, { secret: true })).trim();
}

async function confirm(label, def = true) {
  const v = (await question(`    ${label} ${dim(def ? '[Д/н]' : '[д/Н]')}: `)).trim().toLowerCase();
  if (!v) return def;
  return ['д', 'да', 'y', 'yes'].includes(v);
}

async function choose(label, options, defIndex = 0) {
  console.log(`    ${label}`);
  options.forEach((o, i) => console.log(`      ${i === defIndex ? cyan('›') : ' '} ${bold(i + 1)}. ${o.label}${o.hint ? dim(`  — ${o.hint}`) : ''}`));
  for (;;) {
    const v = (await question(`    Выбор ${dim(`[${defIndex + 1}]`)}: `)).trim();
    const n = v ? Number(v) - 1 : defIndex;
    if (Number.isInteger(n) && n >= 0 && n < options.length) return options[n].value;
    warn(`Введите число от 1 до ${options.length}`);
  }
}

// ---------- команды ----------

function sh(cmd, argv, opts = {}) {
  return spawnSync(cmd, argv, { encoding: 'utf8', cwd: ROOT, ...opts });
}

/** Команда с выводом в терминал; при --dry-run только печатается. */
function run(cmd, argv, { env, cwd = ROOT, secretArgs = [] } = {}) {
  const shown = argv.map((a) => (secretArgs.includes(a) ? '••••' : /\s/.test(a) ? JSON.stringify(a) : a)).join(' ');
  console.log(dim(`    $ ${cmd} ${shown}`));
  if (DRY) return Promise.resolve(0);
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { cwd, env: { ...process.env, ...env }, stdio: 'inherit' });
    p.on('exit', (code) => (code === 0 ? resolve(0) : reject(new Error(`${cmd} завершился с кодом ${code}`))));
    p.on('error', reject);
  });
}

function have(cmd) {
  return sh('/usr/bin/which', [cmd]).status === 0;
}

// ---------- настройки ----------

const saved = (() => {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch {
    return {};
  }
})();

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function bumpVersion(v, kind) {
  const [maj, min, pat] = v.split('-')[0].split('.').map(Number);
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function setVersion(v) {
  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = readJson(pkgPath);
  pkg.version = v;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  // версия пакета в Cargo.toml (первая строка version = ... в секции [package])
  const cargoPath = path.join(TAURI, 'Cargo.toml');
  const cargo = fs.readFileSync(cargoPath, 'utf8').replace(/^(\[package\][\s\S]*?^version\s*=\s*)"[^"]*"/m, `$1"${v}"`);
  fs.writeFileSync(cargoPath, cargo);
}

/** Сертификаты подписи кода из связки ключей. */
function listIdentities() {
  const out = sh('security', ['find-identity', '-v', '-p', 'codesigning']).stdout ?? '';
  const ids = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"(.+)"$/);
    if (m) ids.push({ hash: m[1], name: m[2], team: (m[2].match(/\(([A-Z0-9]{10})\)\s*$/) ?? [])[1] ?? '' });
  }
  return ids;
}

function profileWorks(name) {
  return sh('xcrun', ['notarytool', 'history', '--keychain-profile', name, '--output-format', 'json']).status === 0;
}

// ---------- шаги ----------

async function main() {
  console.log(bold('\nPhotoEdit — сборка подписанного приложения для macOS'));
  if (DRY) console.log(yellow('    Режим --dry-run: команды будут только показаны'));

  // 1. окружение
  step(1, 'Проверка окружения');
  if (process.platform !== 'darwin') fail('Сборка под macOS возможна только на macOS');
  for (const [cmd, hint] of [
    ['cargo', 'установите Rust: curl https://sh.rustup.rs -sSf | sh'],
    ['rustup', 'установите Rust через rustup'],
    ['xcrun', 'установите Xcode Command Line Tools: xcode-select --install'],
    ['codesign', 'нужны Xcode Command Line Tools'],
    ['hdiutil', 'системная утилита macOS'],
  ]) {
    if (!have(cmd)) fail(`Не найдено: ${cmd} — ${hint}`);
  }
  if (sh('xcrun', ['notarytool', '--version']).status !== 0) warn('notarytool не найден — нотаризация будет недоступна (нужен Xcode 13+ или свежие CLT)');
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    info('Зависимости не установлены — ставлю');
    await run('npm', ['install']);
  }
  const dirty = sh('git', ['status', '--porcelain']).stdout?.trim();
  if (dirty) warn('В рабочей копии есть незакоммиченные изменения — они попадут в сборку');
  ok('Окружение в порядке');

  // 2. версия
  step(2, 'Версия');
  const current = readJson(path.join(ROOT, 'package.json')).version;
  let version = current;
  if (!YES) {
    const kind = await choose(`Текущая версия ${bold(current)}. Какой будет новая?`, [
      { label: `Оставить ${current}`, value: 'keep' },
      { label: `Исправления → ${bumpVersion(current, 'patch')}`, value: 'patch', hint: 'patch' },
      { label: `Новые функции → ${bumpVersion(current, 'minor')}`, value: 'minor', hint: 'minor' },
      { label: `Крупный релиз → ${bumpVersion(current, 'major')}`, value: 'major', hint: 'major' },
      { label: 'Ввести вручную', value: 'custom' },
    ]);
    if (kind === 'custom') version = await ask('Версия (semver, например 1.2.0)', current, { validate: (v) => (SEMVER.test(v) ? null : 'Формат X.Y.Z') });
    else if (kind !== 'keep') version = bumpVersion(current, kind);
  }
  ok(`Версия ${version}`);

  // 3. метаданные приложения
  step(3, 'Приложение');
  const user = os.userInfo().username.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'me';
  let productName = saved.productName ?? 'PhotoEdit';
  let identifier = saved.identifier ?? `com.${user}.photoedit`;
  let copyright = saved.copyright ?? `© ${new Date().getFullYear()}`;
  let minimumSystemVersion = saved.minimumSystemVersion ?? '11.0';
  if (!YES) {
    productName = await ask('Название приложения', productName);
    identifier = await ask('Bundle ID (обратный домен, уникальный)', identifier, {
      validate: (v) => (/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(v) ? null : 'Формат com.company.app'),
    });
    copyright = await ask('Копирайт (показывается в «О программе» Finder)', copyright);
    minimumSystemVersion = await ask('Минимальная версия macOS', minimumSystemVersion, { validate: (v) => (/^\d+(\.\d+)*$/.test(v) ? null : 'Например 11.0') });
  }
  ok(`${productName} · ${identifier}`);

  // 4. архитектура
  step(4, 'Архитектура');
  const archs = [
    { label: 'Apple Silicon (arm64)', value: 'aarch64-apple-darwin', hint: 'M1 и новее' },
    { label: 'Intel (x86_64)', value: 'x86_64-apple-darwin' },
    { label: 'Universal (arm64 + x86_64)', value: 'universal-apple-darwin', hint: 'один файл для всех Mac, больше размер' },
  ];
  const target = YES && saved.target ? saved.target : await choose('Под какие Mac собирать?', archs, Math.max(0, archs.findIndex((a) => a.value === saved.target)));
  const needTargets = target === 'universal-apple-darwin' ? ['aarch64-apple-darwin', 'x86_64-apple-darwin'] : [target];
  const installed = sh('rustup', ['target', 'list', '--installed']).stdout ?? '';
  for (const t of needTargets) {
    if (!installed.includes(t)) {
      info(`Нужен Rust target ${t}`);
      await run('rustup', ['target', 'add', t]);
    }
  }
  ok(target);

  // 5. подпись
  step(5, 'Подпись');
  let ids = listIdentities();
  if (!ids.length) {
    warn('В связке ключей нет сертификатов подписи кода');
    info(`Для распространения вне App Store нужен ${bold('Developer ID Application')}.`);
    info('Получить: developer.apple.com → Certificates → «+» → Developer ID Application,');
    info('или Xcode → Settings → Accounts → Manage Certificates.');
    if (!DRY && (await confirm('Импортировать сертификат из .p12 сейчас?', true))) {
      const p12 = await ask('Путь к .p12', '', { validate: (v) => (fs.existsSync(v.replace(/^~/, os.homedir())) ? null : 'Файл не найден') });
      const pass = await askSecret('Пароль от .p12 (ввод скрыт)');
      const keychain = path.join(os.homedir(), 'Library/Keychains/login.keychain-db');
      const r = sh('security', ['import', p12.replace(/^~/, os.homedir()), '-k', keychain, '-P', pass, '-T', '/usr/bin/codesign', '-T', '/usr/bin/security']);
      if (r.status !== 0) fail(`Не удалось импортировать: ${r.stderr.trim()}`);
      ok('Сертификат импортирован');
      ids = listIdentities();
    }
  }
  const devIds = ids.filter((i) => i.name.startsWith('Developer ID Application'));
  const others = ids.filter((i) => !i.name.startsWith('Developer ID Application'));
  const identOptions = [
    ...devIds.map((i) => ({ label: i.name, value: i, hint: 'для распространения, можно нотаризовать' })),
    ...others.map((i) => ({ label: i.name, value: i, hint: 'не подходит для нотаризации' })),
    { label: 'Без подписи', value: null, hint: 'только для проверки, Gatekeeper будет ругаться' },
  ];
  const savedIdx = identOptions.findIndex((o) => o.value && o.value.name === saved.identity);
  let identity = null;
  if (YES && savedIdx >= 0) identity = identOptions[savedIdx].value;
  else if (YES && saved.identity === null) identity = null;
  else identity = await choose('Чем подписать?', identOptions, savedIdx >= 0 ? savedIdx : 0);
  if (identity) ok(`${identity.name}${identity.team ? dim(`  (Team ID ${identity.team})`) : ''}`);
  else warn('Сборка без подписи');

  // 6. нотаризация
  step(6, 'Нотаризация');
  let notary = { method: 'none' };
  const canNotarize = identity && identity.name.startsWith('Developer ID Application');
  if (!canNotarize) {
    info(identity ? 'Нотаризация доступна только с сертификатом Developer ID Application' : 'Без подписи нотаризация невозможна');
  } else {
    const methods = [
      { label: 'Профиль в связке ключей (notarytool)', value: 'profile', hint: 'рекомендуется: пароль хранит macOS' },
      { label: 'Apple ID + пароль приложения', value: 'appleid', hint: 'appleid.apple.com → Пароли приложений' },
      { label: 'Ключ App Store Connect API (.p8)', value: 'apikey', hint: 'удобно для CI' },
      { label: 'Не нотаризовать', value: 'none', hint: 'другие Mac покажут предупреждение' },
    ];
    const savedM = methods.findIndex((m) => m.value === saved.notaryMethod);
    const method = YES && savedM >= 0 ? methods[savedM].value : await choose('Как нотаризовать?', methods, savedM >= 0 ? savedM : 0);
    if (method === 'profile') {
      const profile = YES && saved.notaryProfile ? saved.notaryProfile : await ask('Имя профиля', saved.notaryProfile ?? 'photoedit-notary');
      if (!DRY && !profileWorks(profile)) {
        warn(`Профиль «${profile}» не найден или не работает — создадим`);
        info('notarytool спросит пароль приложения сам; он сохранится в связке ключей.');
        const appleId = await ask('Apple ID (email)', saved.appleId ?? '');
        await run('xcrun', ['notarytool', 'store-credentials', profile, '--apple-id', appleId, '--team-id', identity.team]);
        saved.appleId = appleId;
      }
      notary = { method, profile };
    } else if (method === 'appleid') {
      const appleId = YES && saved.appleId ? saved.appleId : await ask('Apple ID (email)', saved.appleId ?? '');
      const password = await askSecret('Пароль приложения (не пароль Apple ID; ввод скрыт)');
      notary = { method, appleId, password, team: identity.team };
      if (!DRY && (await confirm('Сохранить как профиль связки ключей, чтобы больше не вводить?', true))) {
        const profile = await ask('Имя профиля', 'photoedit-notary');
        await run('xcrun', ['notarytool', 'store-credentials', profile, '--apple-id', appleId, '--team-id', identity.team, '--password', password], { secretArgs: [password] });
        notary = { method: 'profile', profile };
        saved.notaryProfile = profile;
      }
      saved.appleId = appleId;
    } else if (method === 'apikey') {
      const keyPath = await ask('Путь к AuthKey_XXXX.p8', saved.apiKeyPath ?? '', { validate: (v) => (fs.existsSync(v.replace(/^~/, os.homedir())) ? null : 'Файл не найден') });
      const keyId = await ask('Key ID', saved.apiKeyId ?? path.basename(keyPath).match(/AuthKey_(\w+)\.p8/)?.[1] ?? '');
      const issuer = await ask('Issuer ID (UUID из App Store Connect → Keys)', saved.apiIssuer ?? '');
      notary = { method, keyPath: keyPath.replace(/^~/, os.homedir()), keyId, issuer };
      Object.assign(saved, { apiKeyPath: keyPath, apiKeyId: keyId, apiIssuer: issuer });
    }
    if (notary.method !== 'none') ok(`Нотаризация: ${notary.method === 'profile' ? `профиль «${notary.profile}»` : notary.method === 'apikey' ? 'API-ключ' : 'Apple ID'}`);
    else warn('Без нотаризации');
  }

  // 7. git
  let gitTag = false;
  if (version !== current && sh('git', ['rev-parse', '--git-dir']).status === 0 && !YES) {
    gitTag = await confirm(`После сборки закоммитить версию и поставить тег v${version}?`, true);
  }

  // сводка
  step(7, 'Сводка');
  info(`Приложение:   ${bold(productName)} ${version}  (${identifier})`);
  info(`Архитектура:  ${target}`);
  info(`Подпись:      ${identity ? identity.name : red('нет')}`);
  info(`Нотаризация:  ${notary.method === 'none' ? yellow('нет') : notary.method}`);
  info(`Результат:    release/${version}/`);
  if (!YES && !(await confirm('Собираем?', true))) {
    rl.close();
    return;
  }

  // сохраняем ответы без секретов
  Object.assign(saved, {
    productName, identifier, copyright, minimumSystemVersion, target,
    identity: identity ? identity.name : null,
    notaryMethod: notary.method,
    notaryProfile: notary.profile ?? saved.notaryProfile,
  });
  if (!DRY) fs.writeFileSync(SETTINGS, JSON.stringify(saved, null, 2) + '\n');
  if (version !== current && !DRY) setVersion(version);

  // 8. сборка
  step(8, 'Сборка');
  const override = {
    productName,
    identifier,
    bundle: { copyright, macOS: { minimumSystemVersion, hardenedRuntime: true } },
  };
  const overridePath = path.join(os.tmpdir(), `photoedit-release-${process.pid}.json`);
  if (!DRY) fs.writeFileSync(overridePath, JSON.stringify(override));
  const env = { CI: 'false' };
  // подпись делает Tauri; нотаризацию — этот скрипт (переменные APPLE_ID и т.п. не передаём)
  if (identity) env.APPLE_SIGNING_IDENTITY = identity.name;
  await run('npx', ['tauri', 'build', '--target', target, '--bundles', 'app', '--config', overridePath], { env });
  if (!DRY) fs.rmSync(overridePath, { force: true });

  const appPath = path.join(TAURI, 'target', target, 'release', 'bundle', 'macos', `${productName}.app`);
  if (!DRY && !fs.existsSync(appPath)) fail(`Не найден результат сборки: ${appPath}`);
  ok(appPath.replace(ROOT + '/', ''));

  // 9. проверка подписи
  if (identity) {
    step(9, 'Проверка подписи');
    await run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
    if (!DRY) {
      const d = sh('codesign', ['-dv', '--verbose=4', appPath]).stderr;
      const flags = d.match(/flags=0x[0-9a-f]+\(([^)]*)\)/)?.[1] ?? '';
      if (!flags.includes('runtime')) warn('Hardened Runtime не включён — нотаризация не пройдёт');
      else ok('Hardened Runtime включён');
      const team = d.match(/TeamIdentifier=(\S+)/)?.[1];
      if (team) ok(`Team ID ${team}`);
    }
  }

  const notaryArgs = () => {
    if (notary.method === 'profile') return ['--keychain-profile', notary.profile];
    if (notary.method === 'appleid') return ['--apple-id', notary.appleId, '--password', notary.password, '--team-id', notary.team];
    return ['--key', notary.keyPath, '--key-id', notary.keyId, '--issuer', notary.issuer];
  };

  async function notarize(file, what) {
    info(`Отправка ${what} в Apple (обычно 1–10 минут)…`);
    const argv = ['notarytool', 'submit', file, ...notaryArgs(), '--wait', '--output-format', 'json'];
    console.log(dim(`    $ xcrun ${argv.map((a) => (a === notary.password ? '••••' : a)).join(' ')}`));
    if (DRY) return;
    const r = sh('xcrun', argv, { maxBuffer: 16 * 1024 * 1024 });
    let res = {};
    try {
      res = JSON.parse(r.stdout);
    } catch {
      fail(`notarytool: ${r.stderr || r.stdout}`);
    }
    if (res.status !== 'Accepted') {
      // журнал Apple объясняет, что именно не так (неподписанный бинарник, нет runtime и т.п.)
      const log = sh('xcrun', ['notarytool', 'log', res.id, ...notaryArgs()]).stdout;
      console.error(log);
      fail(`Нотаризация ${what}: ${res.status ?? 'ошибка'} — журнал выше`);
    }
    ok(`${what}: Accepted (${res.id})`);
  }

  // 10. нотаризация .app
  const outDir = path.join(ROOT, 'release', version);
  if (!DRY) fs.mkdirSync(outDir, { recursive: true });
  const arch = { 'aarch64-apple-darwin': 'arm64', 'x86_64-apple-darwin': 'x64', 'universal-apple-darwin': 'universal' }[target];
  const base = `${productName}_${version}_${arch}`;
  if (notary.method !== 'none') {
    step(10, 'Нотаризация приложения');
    const zipForNotary = path.join(os.tmpdir(), `${base}-notary.zip`);
    await run('ditto', ['-c', '-k', '--keepParent', appPath, zipForNotary]);
    await notarize(zipForNotary, 'приложение');
    if (!DRY) fs.rmSync(zipForNotary, { force: true });
    await run('xcrun', ['stapler', 'staple', appPath]);
    await run('xcrun', ['stapler', 'validate', appPath]);
  }

  // 11. образ диска и архив
  step(11, 'Образ диска и архив');
  const zipPath = path.join(outDir, `${base}.zip`);
  await run('ditto', ['-c', '-k', '--keepParent', appPath, zipPath]);
  const stage = path.join(os.tmpdir(), `photoedit-dmg-${process.pid}`);
  const dmgPath = path.join(outDir, `${base}.dmg`);
  if (!DRY) {
    fs.rmSync(stage, { recursive: true, force: true });
    fs.mkdirSync(stage, { recursive: true });
  }
  await run('ditto', [appPath, path.join(stage, `${productName}.app`)]);
  if (!DRY) fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
  if (!DRY) fs.rmSync(dmgPath, { force: true });
  await run('hdiutil', ['create', '-volname', `${productName} ${version}`, '-srcfolder', stage, '-ov', '-format', 'UDZO', dmgPath]);
  if (!DRY) fs.rmSync(stage, { recursive: true, force: true });
  if (identity) await run('codesign', ['--force', '--sign', identity.name, '--timestamp', dmgPath]);
  if (notary.method !== 'none') {
    await notarize(dmgPath, 'образ диска');
    await run('xcrun', ['stapler', 'staple', dmgPath]);
  }

  // 12. Gatekeeper
  if (identity && !DRY) {
    step(12, 'Проверка Gatekeeper');
    const a = sh('spctl', ['-a', '-vvv', '-t', 'exec', appPath]);
    const dmg = sh('spctl', ['-a', '-vvv', '-t', 'open', '--context', 'context:primary-signature', dmgPath]);
    (a.status === 0 ? ok : warn)(`Приложение: ${(a.stderr || a.stdout).trim().split('\n').slice(0, 2).join(' · ')}`);
    (dmg.status === 0 ? ok : warn)(`Образ: ${(dmg.stderr || dmg.stdout).trim().split('\n').slice(0, 2).join(' · ')}`);
    if (notary.method === 'none') info('Без нотаризации Gatekeeper на других Mac отклонит приложение — это ожидаемо');
  }

  // контрольные суммы
  if (!DRY) {
    const sums = [zipPath, dmgPath]
      .map((f) => `${sh('shasum', ['-a', '256', f]).stdout.split(' ')[0]}  ${path.basename(f)}`)
      .join('\n');
    fs.writeFileSync(path.join(outDir, 'SHA256SUMS'), sums + '\n');
  }

  // 13. git
  if (gitTag) {
    step(13, 'Git');
    await run('git', ['add', 'package.json', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock']);
    await run('git', ['commit', '-m', `Версия ${version}`]);
    await run('git', ['tag', '-a', `v${version}`, '-m', `${productName} ${version}`]);
    info(`Отправить: git push && git push origin v${version}`);
  }

  console.log(`\n${green(bold('Готово.'))} Файлы в ${bold(path.relative(ROOT, outDir) + '/')}:`);
  console.log(`    ${path.basename(dmgPath)}  — для раздачи пользователям`);
  console.log(`    ${path.basename(zipPath)}  — архив приложения`);
  console.log('    SHA256SUMS');
  rl.close();
}

main().catch((e) => {
  rl.close();
  fail(e.message ?? String(e));
});
