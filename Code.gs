/**
 * Çentik — çok kullanıcılı Google Apps Script backend
 *
 * Kurulum:
 * 1) Bu dosyayı bağlı Google E-Tablo'nun Apps Script projesine yapıştırın.
 * 2) Dağıt > Yeni dağıtım > Web uygulaması
 *    - Yürüten: Ben
 *    - Erişim: Herkes
 * 3) /exec adresini index.html içindeki SCRIPT_URL alanına yazın.
 *
 * Güvenlik notu:
 * - Parolalar düz metin tutulmaz: kullanıcıya özgü salt + Script Properties'te
 *   tutulan pepper + iteratif SHA-256 ile türetilen hash saklanır.
 * - Session tokenının yalnız SHA-256 hash'i saklanır.
 * - 5 hatalı giriş / 15 dk sonrasında hesap 15 dk kilitlenir.
 * - Sık sync çağrıları için 5 dakikalık, anında iptal edilebilir auth cache kullanılır.
 */

const CENTIK_SERVER_BUILD = 'v27-cakili-shared-control';
const CENTIK_API_VERSION = 14;

// YALNIZCA BU E-POSTA ÇENTİK SÜPER YÖNETİCİSİ OLABİLİR.
// Yayına almadan önce aşağıdaki değeri kendi e-posta adresinizle değiştirin.
const SUPER_ADMIN_EMAIL = 'onurtrklmz@gmail.com';

const CFG = Object.freeze({
  USERS_SHEET: 'Kullanicilar',
  SESSIONS_SHEET: 'Oturumlar',
  RECORDS_SHEET: 'Kayitlar',
  JOURNAL_SHEET: 'Cetele',
  PINNED_LISTS_SHEET: 'CakiliListeler',
  PINNED_TASKS_SHEET: 'CakiliGorevler',
  PASSWORD_ROUNDS: 1500,
  JOURNAL_PIN_ROUNDS: 1500,
  JOURNAL_MAX_CHARS: 12000,
  JOURNAL_STATUS_CACHE_SECONDS: 21600,
  SESSION_DAYS: 60,
  RESET_MINUTES: 15,
  MAX_LOGIN_FAILURES: 5,
  FAILURE_WINDOW_MINUTES: 15,
  LOCK_MINUTES: 15,
  ALLOW_SIGNUP: true,
  MAX_PENDING_USERS: 5,
  MAX_TOTAL_USERS: 10,
  SCHEMA_CACHE_SECONDS: 21600,
  SESSION_CLEANUP_SECONDS: 3600,
  SESSION_TOUCH_MINUTES: 720,
  ADMIN_PENDING_CACHE_SECONDS: 120,
  ADMIN_USERS_CACHE_SECONDS: 120,
  AUTH_CACHE_SECONDS: 300
});

function doGet() {
  return out_({ ok: true, app: 'centik', api: CENTIK_API_VERSION, build: CENTIK_SERVER_BUILD });
}

function traceStart_(action, b) {
  const now = Date.now();
  return {
    id: String(b && b.clientTraceId || Utilities.getUuid()).slice(0, 80),
    clientBuild: String(b && b.clientBuild || '').slice(0, 80),
    action: String(action || ''),
    start: now,
    last: now,
    steps: []
  };
}
function traceMark_(tr, name) {
  if (!tr) return;
  const now = Date.now();
  tr.steps.push({ name: String(name || '').slice(0, 80), deltaMs: now - tr.last, totalMs: now - tr.start });
  tr.last = now;
}
function traceFinish_(tr) {
  if (!tr) return null;
  const total = Date.now() - tr.start;
  return {
    id: tr.id,
    action: tr.action,
    clientBuild: tr.clientBuild,
    build: CENTIK_SERVER_BUILD,
    api: CENTIK_API_VERSION,
    totalMs: total,
    steps: tr.steps.slice(0, 30)
  };
}
function withTrace_(result, tr, serverError) {
  const out = result && typeof result === 'object' ? result : { ok: false, error: 'sunucu' };
  out._diag = traceFinish_(tr);
  if (serverError && out._diag) out._diag.serverError = String(serverError).slice(0, 160);
  return out;
}

function doPost(e) {
  let b;
  try { b = JSON.parse((e && e.postData && e.postData.contents) || '{}'); }
  catch (err) { return out_({ ok: false, error: 'bicim', build: CENTIK_SERVER_BUILD, api: CENTIK_API_VERSION }); }

  const action = String(b.action || '').trim();
  const trace = traceStart_(action, b);
  traceMark_(trace, 'request:parsed');
  try {
    // Sık çalışan sync/saveDay çağrılarında şema bakımı ve toplu session temizliği
    // yapma. Bu tablolar kurulumda zaten oluşturulur; auth_ oturum süresini ayrıca doğrular.
    const fastAction = action === 'sync' || action === 'saveDay' || action === 'me' || action === 'pinnedGet' || action === 'pinnedTaskMutate';
    if (!fastAction) { ensureSchemaFast_(); traceMark_(trace, 'schema:checked'); }
    if (action === 'login' || action === 'register' || action === 'resetRequest' || action === 'resetConfirm' || action === 'logout') {
      maybeCleanupSessions_(); traceMark_(trace, 'sessions:maintenance');
    }

    if (action === 'register' && !adminEmail_()) {
      return out_(withTrace_({ ok: false, error: 'admin_ayarsiz' }, trace));
    }

    let result;
    switch (action) {
      case 'register': result = register_(b); break;
      case 'login': result = login_(b); break;
      case 'logout': result = logout_(b); break;
      case 'me': result = me_(b); break;
      case 'setTheme': result = setTheme_(b); break;
      case 'sync': result = sync_(b, trace); break;
      case 'saveDay': result = saveDay_(b, trace); break;
      case 'journalStatus': result = journalStatus_(b, trace); break;
      case 'journalMonthStatus': result = journalMonthStatus_(b, trace); break;
      case 'journalGet': result = journalGet_(b, trace); break;
      case 'journalSave': result = journalSave_(b, trace); break;
      case 'journalPinSet': result = journalPinSet_(b, trace); break;
      case 'journalPinDisable': result = journalPinDisable_(b, trace); break;
      case 'pinnedLists': result = pinnedListsApi_(b, trace); break;
      case 'pinnedCreate': result = pinnedCreate_(b, trace); break;
      case 'pinnedRename': result = pinnedRename_(b, trace); break;
      case 'pinnedDelete': result = pinnedDelete_(b, trace); break;
      case 'pinnedShare': result = pinnedShare_(b, trace); break;
      case 'pinnedGet': result = pinnedGet_(b, trace); break;
      case 'pinnedTaskMutate': result = pinnedTaskMutate_(b, trace); break;
      case 'resetRequest': result = resetRequest_(b); break;
      case 'resetConfirm': result = resetConfirm_(b); break;
      case 'adminPending': result = adminPending_(b, trace); break;
      case 'adminUsers': result = adminUsers_(b, trace); break;
      case 'adminSetStatus': result = adminSetStatus_(b, trace); break;
      case 'diagnostics': result = diagnostics_(b, trace); break;
      default: result = { ok: false, error: 'islem' }; break;
    }
    traceMark_(trace, 'response:ready');
    return out_(withTrace_(result, trace));
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    traceMark_(trace, 'response:error');
    return out_(withTrace_({ ok: false, error: 'sunucu' }, trace, err && err.message ? err.message : err));
  }
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}

function ss_() { return SpreadsheetApp.getActive(); }

// Performans: tablo şeması her API çağrısında tekrar taranmaz.
// Cache düşerse veya 6 saat dolarsa güvenli biçimde yeniden doğrulanır.
function ensureSchemaFast_() {
  const cache = CacheService.getScriptCache();
  const key = 'centik-schema-v9-cakili|' + (adminEmail_() || 'no-admin');
  if (cache.get(key)) return;
  ensureSchema_();
  try { cache.put(key, '1', CFG.SCHEMA_CACHE_SECONDS); } catch (e) {}
}

// Performans: süresi biten oturumları her istekte taramak yerine en fazla saatte bir temizle.
function maybeCleanupSessions_() {
  const cache = CacheService.getScriptCache();
  const key = 'centik-session-cleanup-v2';
  if (cache.get(key)) return;
  cleanupSessions_();
  try { cache.put(key, '1', CFG.SESSION_CLEANUP_SECONDS); } catch (e) {}
}

// Görev verisi için sunucu tarafında uzun süreli cache kullanılmaz.
// Cihazlar arası güncellik, kullanıcıya ait artan revision değeriyle izlenir.
function revisionKey_(userId) { return 'centik-revision-v1|' + String(userId || ''); }
function getRevision_(userId) {
  try {
    const raw = PropertiesService.getScriptProperties().getProperty(revisionKey_(userId));
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
  } catch (e) { return 0; }
}
function bumpRevision_(userId) {
  const next = getRevision_(userId) + 1;
  PropertiesService.getScriptProperties().setProperty(revisionKey_(userId), String(next));
  return next;
}

// Revision'a bağlı kısa ömürlü görev snapshot cache'i.
// Cache anahtarında revision bulunduğu için eski veri yeni revision'da asla servis edilmez.
// Böylece cihazlar arası tazelik korunurken tekrar tam Sheet taramaları azaltılır.
function recordsSnapshotKey_(userId, revision) {
  return 'centik-records-snapshot-v1|' + String(userId || '') + '|' + String(Number(revision) || 0);
}
function getRecordsSnapshot_(userId, revision) {
  try {
    const raw = CacheService.getScriptCache().get(recordsSnapshotKey_(userId, revision));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch (e) { return null; }
}
function putRecordsSnapshot_(userId, revision, days) {
  try {
    const payload = JSON.stringify(days || {});
    // CacheService öğe boyutu sınırlı olduğundan büyük snapshotlarda cache'i sessizce atla.
    if (payload.length > 85000) return;
    CacheService.getScriptCache().put(recordsSnapshotKey_(userId, revision), payload, 300);
  } catch (e) {}
}

function updatedMs_(value, fallback) {
  if (value instanceof Date && !isNaN(value.getTime())) return value.getTime();
  const d = value ? new Date(value) : null;
  return d && !isNaN(d.getTime()) ? d.getTime() : Number(fallback || 0);
}

function dedupeItems_(items) {
  const out = [], pos = Object.create(null);
  (Array.isArray(items) ? items : []).forEach(function(it) {
    const clean = {
      id: String(it && it.id || '').trim().slice(0, 80),
      t: String(it && it.t || '').trim().slice(0, 1000),
      done: !!(it && it.done),
      parentId: String(it && it.parentId || '').trim().slice(0, 80)
    };
    if (!clean.id || !clean.t) return;
    if (clean.parentId === clean.id) clean.parentId = '';
    if (Object.prototype.hasOwnProperty.call(pos, clean.id)) out[pos[clean.id]] = clean;
    else { pos[clean.id] = out.length; out.push(clean); }
  });
  const byId = Object.create(null);
  out.forEach(function(it) { byId[it.id] = it; });
  out.forEach(function(it) {
    if (!it.parentId) return;
    const p = byId[it.parentId];
    if (!p || p === it) { it.parentId = ''; return; }
    // Çentik arayüzü tek seviyeli alt görev kullanır; daha derin veri gelirse köke düzleştir.
    if (p.parentId) it.parentId = byId[p.parentId] ? p.parentId : '';
  });
  return out;
}

function adminPendingCacheKey_() { return 'centik-admin-pending-v2'; }
function invalidateAdminPendingCache_() {
  try { CacheService.getScriptCache().remove(adminPendingCacheKey_()); } catch (e) {}
}
function pendingApprovalsSnapshot_() {
  const cache = CacheService.getScriptCache();
  try {
    const raw = cache.get(adminPendingCacheKey_());
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  const v = users_().getDataRange().getValues();
  const list = [];
  for (let i = 1; i < v.length; i++) {
    const u = v[i];
    if (String(u[5]) !== 'bekliyor') continue;
    list.push({
      id: String(u[0]),
      email: String(u[1]),
      name: String(u[2]),
      createdAt: u[6] instanceof Date ? u[6].toISOString() : String(u[6] || '')
    });
  }
  list.sort(function(x, y) { return String(x.createdAt).localeCompare(String(y.createdAt)); });
  const payload = { users: list, count: list.length, maxPending: CFG.MAX_PENDING_USERS, maxUsers: CFG.MAX_TOTAL_USERS };
  try { cache.put(adminPendingCacheKey_(), JSON.stringify(payload), CFG.ADMIN_PENDING_CACHE_SECONDS); } catch (e) {}
  return payload;
}

function adminUsersCacheKey_() { return 'centik-admin-users-v1'; }
function invalidateAdminUsersCache_() {
  try { CacheService.getScriptCache().remove(adminUsersCacheKey_()); } catch (e) {}
}
function registeredUsersSnapshot_() {
  const cache = CacheService.getScriptCache();
  try {
    const raw = cache.get(adminUsersCacheKey_());
    if (raw) return JSON.parse(raw);
  } catch (e) {}
  const v = users_().getDataRange().getValues();
  const list = [];
  for (let i = 1; i < v.length; i++) {
    const u = v[i];
    if (String(u[5]) !== 'aktif') continue;
    list.push({
      id: String(u[0]),
      email: String(u[1]),
      name: String(u[2]),
      role: String(u[13] || 'uye'),
      status: String(u[5] || ''),
      createdAt: u[6] instanceof Date ? u[6].toISOString() : String(u[6] || ''),
      approvedAt: u[14] instanceof Date ? u[14].toISOString() : String(u[14] || '')
    });
  }
  list.sort(function(x, y) {
    if (x.role === 'admin' && y.role !== 'admin') return -1;
    if (y.role === 'admin' && x.role !== 'admin') return 1;
    return String(x.name || x.email).localeCompare(String(y.name || y.email), 'tr');
  });
  const payload = { users: list, count: list.length, maxUsers: CFG.MAX_TOTAL_USERS };
  try { cache.put(adminUsersCacheKey_(), JSON.stringify(payload), CFG.ADMIN_USERS_CACHE_SECONDS); } catch (e) {}
  return payload;
}

function ensureSchema_() {
  const ss = ss_();
  const recordHeaders = ['UserID', 'Tarih', 'Görev', 'Tamamlandı', 'ID', 'Güncelleme', 'ParentID'];
  let records = ss.getSheetByName(CFG.RECORDS_SHEET);

  // Eski tek-kullanıcı tablosuna dokunma; yedekleyip yeni şema oluştur.
  if (records && records.getLastColumn() > 0) {
    const current = records.getRange(1, 1, 1, records.getLastColumn()).getValues()[0].map(String);
    if (current[0] !== 'UserID') {
      let backup = 'Kayitlar_Eski_TekKullanici_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');
      records.setName(backup);
      records = null;
    }
  }
  if (!records) {
    records = ss.insertSheet(CFG.RECORDS_SHEET);
    records.appendRow(recordHeaders);
    records.setFrozenRows(1);
    records.getRange('B:B').setNumberFormat('@');
  } else if (String(records.getRange(1, 7).getValue() || '') !== 'ParentID') {
    records.getRange(1, 7).setValue('ParentID');
  }

  const userSheet = sheetWithHeaders_(CFG.USERS_SHEET, [
    'UserID','Email','Ad','Salt','PasswordHash','Durum','CreatedAt','UpdatedAt',
    'FailedCount','FirstFailedAt','LockedUntil','ResetHash','ResetUntil','Rol','OnayZamani','Tema'
  ]);
  ensureJournalPinColumns_(userSheet);
  ensureUserSchema_(userSheet);
  sheetWithHeaders_(CFG.SESSIONS_SHEET, [
    'TokenHash','UserID','ExpiresAt','CreatedAt','LastSeen'
  ]);
  const journalSheet = sheetWithHeaders_(CFG.JOURNAL_SHEET, [
    'UserID','Tarih','Icerik','UpdatedAt'
  ]);
  journalSheet.getRange('B:B').setNumberFormat('@');
  sheetWithHeaders_(CFG.PINNED_LISTS_SHEET, [
    'ListID','OwnerUserID','Baslik','SharedUserID','CreatedAt','UpdatedAt','Revision'
  ]);
  sheetWithHeaders_(CFG.PINNED_TASKS_SHEET, [
    'ListID','TaskID','Gorev','Tamamlandi','ParentID','Sira','UpdatedAt'
  ]);
}

function sheetWithHeaders_(name, headers) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.appendRow(headers);
    sh.setFrozenRows(1);
    return sh;
  }
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const existing = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  headers.forEach(function(h) {
    if (existing.indexOf(h) === -1) {
      const col = existing.length + 1;
      sh.getRange(1, col).setValue(h);
      existing.push(h);
    }
  });
  sh.setFrozenRows(1);
  return sh;
}

function ensureJournalPinColumns_(sh) {
  if (!sh) return;
  const wanted = ['CetelePinSalt','CetelePinHash','CetelePinFailedCount','CetelePinFirstFailedAt','CetelePinLockedUntil'];
  if (sh.getMaxColumns() < 21) sh.insertColumnsAfter(sh.getMaxColumns(), 21 - sh.getMaxColumns());
  const current = sh.getRange(1, 17, 1, 5).getValues()[0].map(String);
  if (wanted.every(function(h, i) { return current[i] === h; })) return;

  // Eski deneme sürümlerinden kalmış KullaniciAdi gibi ek sütunları silmeyiz.
  // 17. sütundan itibaren başka veri varsa beş yeni sütun açıp eski ek sütunları sağa kaydırırız.
  const hasExtra = current.some(function(v) { return !!String(v || '').trim(); });
  if (hasExtra) sh.insertColumnsAfter(16, 5);
  sh.getRange(1, 17, 1, 5).setValues([wanted]);
}

function ensureUserSchema_(sh) {
  if (!sh || sh.getLastRow() < 2) return;
  const v = sh.getDataRange().getValues();
  const now = now_();
  const updates = [];
  for (let i = 1; i < v.length; i++) {
    let changed = false;
    const row = v[i].slice();
    while (row.length < 16) row.push('');

    // Tek ve sabit süper yönetici kuralı:
    // SUPER_ADMIN_EMAIL ile eşleşen hesap her zaman aktif + admin olur.
    // Başka hiçbir kullanıcı satırında "admin" rolü kalmasına izin verilmez.
    if (isSuperAdminEmail_(row[1])) {
      if (String(row[5]) !== 'aktif') { row[5] = 'aktif'; changed = true; }
      if (String(row[13]) !== 'admin') { row[13] = 'admin'; changed = true; }
      if (!row[14]) { row[14] = row[6] || now; changed = true; }
    } else {
      if (!row[13] || String(row[13]) === 'admin') { row[13] = 'uye'; changed = true; }
      if (String(row[5]) === 'aktif' && !row[14]) { row[14] = row[6] || now; changed = true; }
    }

    const theme = normalizeTheme_(row[15]);
    if (String(row[15] || '') !== theme) { row[15] = theme; changed = true; }

    if (changed) updates.push({ row: i + 1, values: row.slice(0, 16) });
  }
  updates.forEach(function(u) { sh.getRange(u.row, 1, 1, 16).setValues([u.values]); });
  if (updates.length) { invalidateAdminPendingCache_(); invalidateAdminUsersCache_(); }
}

function users_() { return ss_().getSheetByName(CFG.USERS_SHEET); }
function sessions_() { return ss_().getSheetByName(CFG.SESSIONS_SHEET); }
function records_() { return ss_().getSheetByName(CFG.RECORDS_SHEET); }
function journals_() { return ss_().getSheetByName(CFG.JOURNAL_SHEET); }
function pinnedListsSheet_() { return ss_().getSheetByName(CFG.PINNED_LISTS_SHEET); }
function pinnedTasksSheet_() { return ss_().getSheetByName(CFG.PINNED_TASKS_SHEET); }

function normalizeEmail_(v) { return String(v || '').trim().toLowerCase(); }
function validEmail_(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) && v.length <= 254; }
function validPassword_(v) { return typeof v === 'string' && v.length >= 10 && v.length <= 200; }
function cleanName_(v) { return String(v || '').trim().replace(/\s+/g, ' ').slice(0, 60); }
function normalizeTheme_(v) { return String(v || '').trim().toLowerCase() === 'mor' ? 'mor' : 'lacivert'; }
function now_() { return new Date(); }
function dateStr_(v) {
  return v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(v || '');
}

function randomHex_(bytes) {
  let out = '';
  while (out.length < bytes * 2) out += Utilities.getUuid().replace(/-/g, '');
  return out.slice(0, bytes * 2);
}

function bytesToHex_(bytes) {
  return bytes.map(function(b) { const n = b < 0 ? b + 256 : b; return ('0' + n.toString(16)).slice(-2); }).join('');
}

function sha256_(s) {
  return bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8));
}

function pepper_() {
  const p = PropertiesService.getScriptProperties();
  let value = p.getProperty('CENTIK_PASSWORD_PEPPER');
  if (!value) {
    value = randomHex_(32);
    p.setProperty('CENTIK_PASSWORD_PEPPER', value);
  }
  return value;
}

function hashPassword_(password, salt) {
  // Apps Script'te bcrypt/Argon2 yerleşik olmadığı için iteratif SHA-256.
  // Pepper yalnız bir kez okunur; aksi halde her turda PropertiesService çağrısı çok pahalı olur.
  const pep = pepper_();
  let h = sha256_(salt + '|' + password + '|' + pep);
  for (let i = 1; i < CFG.PASSWORD_ROUNDS; i++) h = sha256_(h + '|' + salt + '|' + pep);
  return h;
}

function journalPepper_() {
  const p = PropertiesService.getScriptProperties();
  let value = p.getProperty('CENTIK_JOURNAL_PIN_PEPPER');
  if (!value) {
    value = randomHex_(32);
    p.setProperty('CENTIK_JOURNAL_PIN_PEPPER', value);
  }
  return value;
}

function validJournalPin_(pin) { return /^(?:\d{4}|\d{6})$/.test(String(pin || '')); }
function hashJournalPin_(pin, salt) {
  const pep = journalPepper_();
  // Çetele PIN hash alanını diğer kimlik doğrulama hash'lerinden ayıran sabit etiket.
  let h = sha256_('cetele|' + salt + '|' + String(pin || '') + '|' + pep);
  for (let i = 1; i < CFG.JOURNAL_PIN_ROUNDS; i++) h = sha256_(h + '|' + salt + '|' + pep);
  return h;
}

function safeEq_(a, b) {
  a = String(a || ''); b = String(b || '');
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}

function findUserByEmail_(email) {
  const sh = users_();
  const v = sh.getDataRange().getValues();
  for (let i = 1; i < v.length; i++) {
    if (normalizeEmail_(v[i][1]) === email) return { row: i + 1, values: v[i] };
  }
  return null;
}

function findUserById_(id) {
  const sh = users_();
  const v = sh.getDataRange().getValues();
  for (let i = 1; i < v.length; i++) if (String(v[i][0]) === String(id)) return { row: i + 1, values: v[i] };
  return null;
}

function journalPinEnabledFromUser_(u) {
  if (!u) return false;
  if (String(u[16] || '') === '__enabled__') return true;
  return !!String(u[16] || '') && !!String(u[17] || '');
}

function publicUser_(u) {
  return {
    id: String(u[0]),
    email: String(u[1]),
    name: String(u[2]),
    role: String(u[13] || 'uye'),
    theme: normalizeTheme_(u[15]),
    journalPinEnabled: journalPinEnabledFromUser_(u)
  };
}


function adminEmail_() {
  const email = normalizeEmail_(SUPER_ADMIN_EMAIL);
  return validEmail_(email) ? email : '';
}

function isSuperAdminEmail_(email) {
  const admin = adminEmail_();
  return !!admin && normalizeEmail_(email) === admin;
}

function isAdminUser_(u) {
  return !!u &&
    String(u[5] || '') === 'aktif' &&
    String(u[13] || '') === 'admin' &&
    isSuperAdminEmail_(u[1]);
}

function countUsersByStatus_(status) {
  const v = users_().getDataRange().getValues();
  let n = 0;
  for (let i = 1; i < v.length; i++) if (String(v[i][5]) === status) n++;
  return n;
}

function totalUsers_() {
  return Math.max(0, users_().getLastRow() - 1);
}

/**
 * Süper yönetici artık kod içindeki SUPER_ADMIN_EMAIL sabitiyle belirlenir.
 * Ek bootstrap fonksiyonu gerekmez. Mevcut kullanıcı bu e-posta ile eşleşiyorsa
 * ensureSchema_() sırasında otomatik olarak aktif + admin yapılır.
 */

function register_(b) {
  if (!CFG.ALLOW_SIGNUP) return { ok: false, error: 'kayit_kapali' };
  const email = normalizeEmail_(b.email);
  const password = String(b.password || '');
  const name = cleanName_(b.name);
  if (!validEmail_(email)) return { ok: false, error: 'eposta' };
  if (!validPassword_(password)) return { ok: false, error: 'parola' };
  if (name.length < 2) return { ok: false, error: 'ad' };

  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    if (findUserByEmail_(email)) return { ok: false, error: 'hesap_var' };
    if (totalUsers_() >= CFG.MAX_TOTAL_USERS) return { ok: false, error: 'kayit_limiti' };

    const isSuperAdmin = isSuperAdminEmail_(email);
    if (!isSuperAdmin && countUsersByStatus_('bekliyor') >= CFG.MAX_PENDING_USERS) {
      return { ok: false, error: 'basvuru_limiti' };
    }

    const salt = randomHex_(16);
    const id = Utilities.getUuid();
    const t = now_();
    const status = isSuperAdmin ? 'aktif' : 'bekliyor';
    const role = isSuperAdmin ? 'admin' : 'uye';
    const approvedAt = isSuperAdmin ? t : '';
    users_().appendRow([id, email, name, salt, hashPassword_(password, salt), status, t, t, 0, '', '', '', '', role, approvedAt, 'lacivert']);
    invalidateAdminPendingCache_();
    invalidateAdminUsersCache_();

    if (!isSuperAdmin) notifyAdminNewRegistration_(name, email);
    return isSuperAdmin
      ? { ok: true, pending: false, approved: true, admin: true }
      : { ok: true, pending: true };
  } finally { lock.releaseLock(); }
}

function notifyAdminNewRegistration_(name, email) {
  const admin = adminEmail_();
  if (!validEmail_(admin)) return;
  try {
    MailApp.sendEmail({
      to: admin,
      subject: 'Çentik — yeni kullanıcı onayı',
      htmlBody: '<p>Yeni bir Çentik hesap başvurusu var.</p><p><b>Ad:</b> ' + htmlEscape_(name) + '<br><b>E-posta:</b> ' + htmlEscape_(email) + '</p><p>Çentik uygulamasında Hesap bölümünden başvuruyu onaylayabilir veya reddedebilirsiniz.</p>',
      name: 'Çentik'
    });
  } catch (err) {
    console.error('Admin notification failed: ' + err);
  }
}

function htmlEscape_(s) {
  return String(s || '').replace(/[&<>"']/g, function(c) {
    return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];
  });
}

// Kısa süreli güvenli oturum doğrulama cache'i.
// Amaç: her sync isteğinde Oturumlar + Kullanicilar tablolarını tekrar okumamak.
// Cache yalnız token hash'i ile anahtarlanır; parola/salt/hash gibi hassas kullanıcı
// alanları cache'e konmaz. Tüm session iptal yollarında ilgili cache anında silinir.
function authCacheKey_(tokenHash) {
  return 'centik-auth-v1|' + String(tokenHash || '');
}
function authCacheUser_(u) {
  const x = new Array(21).fill('');
  x[0] = String(u && u[0] || '');
  x[1] = String(u && u[1] || '');
  x[2] = String(u && u[2] || '');
  x[5] = String(u && u[5] || '');
  x[13] = String(u && u[13] || 'uye');
  x[15] = normalizeTheme_(u && u[15]);
  // PIN'in salt/hash'i auth cache'e girmez; yalnız etkin/pasif bilgisi taşınır.
  x[16] = journalPinEnabledFromUser_(u) ? '__enabled__' : '';
  return x;
}
function getAuthCache_(tokenHash) {
  try {
    const raw = CacheService.getScriptCache().get(authCacheKey_(tokenHash));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.user)) return null;
    const exp = Number(parsed.expiresMs || 0);
    if (!exp || exp <= Date.now()) {
      CacheService.getScriptCache().remove(authCacheKey_(tokenHash));
      return null;
    }
    return parsed;
  } catch (e) { return null; }
}
function putAuthCache_(tokenHash, user, expires) {
  try {
    const exp = expires instanceof Date ? expires.getTime() : Number(expires || 0);
    if (!tokenHash || !exp || exp <= Date.now()) return;
    CacheService.getScriptCache().put(authCacheKey_(tokenHash), JSON.stringify({
      user: authCacheUser_(user),
      expiresMs: exp
    }), CFG.AUTH_CACHE_SECONDS);
  } catch (e) {}
}
function invalidateAuthHash_(tokenHash) {
  if (!tokenHash) return;
  try { CacheService.getScriptCache().remove(authCacheKey_(tokenHash)); } catch (e) {}
}
function invalidateUserAuthCaches_(userId) {
  if (!userId) return;
  try {
    const sh = sessions_();
    const v = sh.getDataRange().getValues();
    for (let i = 1; i < v.length; i++) {
      if (String(v[i][1]) === String(userId)) invalidateAuthHash_(String(v[i][0] || ''));
    }
  } catch (e) {}
}

function login_(b) {
  const email = normalizeEmail_(b.email);
  const password = String(b.password || '');
  if (!validEmail_(email) || !password) return { ok: false, error: 'giris' };

  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const found = findUserByEmail_(email);
    if (!found) {
      // Zaman farkını azaltmak için sahte hash hesapla.
      hashPassword_(password, '00000000000000000000000000000000');
      return { ok: false, error: 'giris' };
    }
    const u = found.values;
    const now = now_();
    const lockedUntil = u[10] instanceof Date ? u[10] : (u[10] ? new Date(u[10]) : null);
    if (lockedUntil && lockedUntil.getTime() > now.getTime()) return { ok: false, error: 'kilitli', until: lockedUntil.toISOString() };

    const candidate = hashPassword_(password, String(u[3]));
    if (!safeEq_(candidate, String(u[4]))) {
      noteFailedLogin_(found.row, u, now);
      return { ok: false, error: 'giris' };
    }

    const status = String(u[5]);
    if (status === 'bekliyor') return { ok: false, error: 'bekliyor' };
    if (status === 'reddedildi') return { ok: false, error: 'reddedildi' };
    if (status !== 'aktif') return { ok: false, error: 'pasif' };

    clearFailedLogin_(found.row);
    const session = createSession_(String(u[0]), u);
    return { ok: true, token: session.token, user: publicUser_(u) };
  } finally { lock.releaseLock(); }
}

function noteFailedLogin_(row, u, now) {
  const sh = users_();
  let count = Number(u[8]) || 0;
  let first = u[9] instanceof Date ? u[9] : (u[9] ? new Date(u[9]) : null);
  const windowMs = CFG.FAILURE_WINDOW_MINUTES * 60000;
  if (!first || now.getTime() - first.getTime() > windowMs) { count = 0; first = now; }
  count++;
  let locked = '';
  if (count >= CFG.MAX_LOGIN_FAILURES) {
    locked = new Date(now.getTime() + CFG.LOCK_MINUTES * 60000);
    count = 0; first = '';
  }
  sh.getRange(row, 9, 1, 3).setValues([[count, first, locked]]);
}

function clearFailedLogin_(row) { users_().getRange(row, 9, 1, 3).setValues([[0, '', '']]); }

function createSession_(userId, user) {
  const token = randomHex_(32);
  const hash = sha256_(token);
  const now = now_();
  const expires = new Date(now.getTime() + CFG.SESSION_DAYS * 86400000);
  sessions_().appendRow([hash, userId, expires, now, now]);
  if (user) putAuthCache_(hash, user, expires);
  return { token, expires };
}


function auth_(token, trace) {
  traceMark_(trace, 'auth:start');
  token = String(token || '');
  if (token.length < 40) return null;
  const hash = sha256_(token);

  // En sık çalışan yol: 5 dakikalık güvenli auth cache.
  const cached = getAuthCache_(hash);
  if (cached) {
    traceMark_(trace, 'auth:cache-hit');
    return { user: cached.user, sessionRow: 0, cached: true };
  }
  traceMark_(trace, 'auth:cache-miss');

  const sh = sessions_();
  const v = sh.getDataRange().getValues();
  traceMark_(trace, 'auth:sessions-read:' + Math.max(0, v.length - 1));
  const now = now_();
  for (let i = 1; i < v.length; i++) {
    if (!safeEq_(String(v[i][0]), hash)) continue;
    let expires = v[i][2] instanceof Date ? v[i][2] : new Date(v[i][2]);
    if (!expires || expires.getTime() <= now.getTime()) {
      invalidateAuthHash_(hash);
      sh.deleteRow(i + 1);
      return null;
    }
    // 60 günlük kayan oturum korunur; fakat her API çağrısında Sheet yazımı yapılmaz.
    // Cache miss olduğunda ve son dokunuş 12 saatten eskiyse süre tekrar 60 güne uzatılır.
    const lastSeen = v[i][4] instanceof Date ? v[i][4] : (v[i][4] ? new Date(v[i][4]) : null);
    const touchMs = CFG.SESSION_TOUCH_MINUTES * 60000;
    if (!lastSeen || now.getTime() - lastSeen.getTime() >= touchMs) {
      expires = new Date(now.getTime() + CFG.SESSION_DAYS * 86400000);
      sh.getRange(i + 1, 3, 1, 3).setValues([[expires, v[i][3], now]]);
      traceMark_(trace, 'auth:session-touched');
    }
    const found = findUserById_(String(v[i][1]));
    traceMark_(trace, 'auth:user-read');
    if (!found || String(found.values[5]) !== 'aktif') {
      invalidateAuthHash_(hash);
      return null;
    }
    putAuthCache_(hash, found.values, expires);
    traceMark_(trace, 'auth:cache-put');
    return { user: found.values, sessionRow: i + 1, cached: false };
  }
  invalidateAuthHash_(hash);
  return null;
}

function me_(b) {
  const a = auth_(b.token);
  return a ? { ok: true, user: publicUser_(a.user) } : { ok: false, error: 'oturum' };
}

function setTheme_(b) {
  const a = auth_(b.token);
  if (!a) return { ok: false, error: 'oturum' };
  const raw = String(b.theme || '').trim().toLowerCase();
  if (raw !== 'lacivert' && raw !== 'mor') return { ok: false, error: 'tema' };
  const found = findUserById_(String(a.user[0]));
  if (!found) return { ok: false, error: 'oturum' };
  const t = now_();
  users_().getRange(found.row, 16).setValue(raw);
  users_().getRange(found.row, 8).setValue(t);
  // Aynı hesabın diğer cihazlarındaki kısa auth cache'lerinde eski tema kalmasın.
  invalidateUserAuthCaches_(String(a.user[0]));
  return { ok: true, theme: raw };
}

function logout_(b) {
  const token = String(b.token || '');
  if (!token) return { ok: true };
  const hash = sha256_(token);
  invalidateAuthHash_(hash);
  const sh = sessions_();
  const v = sh.getDataRange().getValues();
  for (let i = v.length - 1; i >= 1; i--) if (safeEq_(String(v[i][0]), hash)) sh.deleteRow(i + 1);
  return { ok: true };
}

function cleanupSessions_() {
  const sh = ss_().getSheetByName(CFG.SESSIONS_SHEET);
  if (!sh || sh.getLastRow() < 2) return;
  const v = sh.getDataRange().getValues();
  const now = Date.now();
  for (let i = v.length - 1; i >= 1; i--) {
    const d = v[i][2] instanceof Date ? v[i][2] : new Date(v[i][2]);
    if (!d || d.getTime() <= now) { invalidateAuthHash_(String(v[i][0] || '')); sh.deleteRow(i + 1); }
  }
}

function sync_(b, trace) {
  traceMark_(trace, 'sync:start');
  const a = auth_(b.token, trace);
  if (!a) return { ok: false, error: 'oturum' };
  const userId = String(a.user[0]);
  const revision = getRevision_(userId);
  traceMark_(trace, 'sync:revision:' + revision);
  const hasKnown = b.knownRevision !== null && b.knownRevision !== undefined && b.knownRevision !== '';
  const known = hasKnown ? Number(b.knownRevision) : null;

  // Revision aynıysa görev tablosuna hiç dokunma.
  if (hasKnown && Number.isFinite(known) && Math.floor(known) === revision) {
    traceMark_(trace, 'sync:unchanged');
    return { ok: true, user: publicUser_(a.user), unchanged: true, revision: revision };
  }

  // Aynı revision daha önce okunduysa doğrudan güvenli snapshot cache'inden dön.
  const cached = getRecordsSnapshot_(userId, revision);
  traceMark_(trace, cached ? 'sync:snapshot-hit' : 'sync:snapshot-miss');
  if (cached) {
    return { ok: true, user: publicUser_(a.user), days: cached, unchanged: false, revision: revision };
  }

  const sh = records_();
  const lastRow = sh.getLastRow();
  traceMark_(trace, 'sync:records-meta:' + Math.max(0, lastRow - 1));
  const days = {};
  if (lastRow > 1) {
    const v = sh.getRange(2, 1, lastRow - 1, 7).getValues();
    traceMark_(trace, 'sync:records-read:' + v.length);
    const best = Object.create(null);
    for (let i = 0; i < v.length; i++) {
      const r = v[i];
      if (String(r[0]) !== userId || !r[1]) continue;
      const d = dateStr_(r[1]), id = String(r[4] || '').trim().slice(0, 80), t = String(r[2] || '').trim().slice(0, 1000);
      if (!id || !t) continue;
      const k = d + '\u001f' + id, stamp = updatedMs_(r[5], i + 2), prev = best[k];
      if (!prev || stamp > prev.stamp || (stamp === prev.stamp && i > prev.index)) {
        best[k] = { date: d, index: i, stamp: stamp, item: { id: id, t: t, done: r[3] === true || String(r[3]).toUpperCase() === 'TRUE', parentId: String(r[6] || '').trim().slice(0, 80) } };
      }
    }
    Object.keys(best).map(function(k) { return best[k]; }).sort(function(a, b) { return a.index - b.index; }).forEach(function(x) {
      (days[x.date] = days[x.date] || []).push(x.item);
    });
  }
  putRecordsSnapshot_(userId, revision, days);
  traceMark_(trace, 'sync:done');
  return { ok: true, user: publicUser_(a.user), days: days, unchanged: false, revision: revision };
}

function saveOpCacheKey_(userId, opId) {
  return 'centik-save-op-v1|' + String(userId || '') + '|' + String(opId || '').slice(0, 160);
}
function getSavedOp_(userId, opId) {
  if (!opId) return null;
  try { const raw = CacheService.getScriptCache().get(saveOpCacheKey_(userId, opId)); return raw ? JSON.parse(raw) : null; }
  catch (e) { return null; }
}
function rememberSavedOp_(userId, opId, result) {
  if (!opId) return;
  try { CacheService.getScriptCache().put(saveOpCacheKey_(userId, opId), JSON.stringify(result), 600); } catch (e) {}
}

function saveDay_(b, trace) {
  traceMark_(trace, 'save:start');
  const a = auth_(b.token, trace);
  if (!a) return { ok: false, error: 'oturum' };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ''))) return { ok: false, error: 'tarih' };
  const userId = String(a.user[0]);
  const date = String(b.date);
  const items = Array.isArray(b.items) ? b.items.slice(0, 200) : [];
  const clientKnownRaw = b.knownRevision;
  const opId = String(b.opId || '').trim().slice(0, 160);
  const remembered = getSavedOp_(userId, opId);
  if (remembered) return remembered;

  const cleaned = dedupeItems_(items);
  traceMark_(trace, 'save:normalized:' + cleaned.length);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(12000)) { traceMark_(trace, 'save:lock-timeout'); return { ok: false, error: 'mesgul' }; }
  traceMark_(trace, 'save:lock-acquired');
  try {
    // İlk istek yanıtı istemciye ulaşmadan retry başladıysa, kilidi aldıktan sonra
    // aynı işlem kimliğini yeniden kontrol et; aynı günü ikinci kez yazma.
    const rememberedAfterLock = getSavedOp_(userId, opId);
    if (rememberedAfterLock) return rememberedAfterLock;
    const beforeRevision = getRevision_(userId);
    traceMark_(trace, 'save:revision-before:' + beforeRevision);
    const beforeSnapshot = getRecordsSnapshot_(userId, beforeRevision);
    const hasClientKnown = clientKnownRaw !== null && clientKnownRaw !== undefined && clientKnownRaw !== '';
    const clientKnown = hasClientKnown ? Number(clientKnownRaw) : null;
    const needsSync = !hasClientKnown || !Number.isFinite(clientKnown) || Math.floor(clientKnown) !== beforeRevision;
    const sh = records_();
    const lastRow = sh.getLastRow();
    const matches = [];

    // Yalnız UserID + Tarih kolonlarını okuyarak bu güne ait mevcut satırları bul.
    if (lastRow > 1) {
      const keys = sh.getRange(2, 1, lastRow - 1, 2).getValues();
      traceMark_(trace, 'save:index-read:' + keys.length);
      for (let i = 0; i < keys.length; i++) {
        if (String(keys[i][0]) === userId && dateStr_(keys[i][1]) === date) matches.push(i + 2);
      }
    }

    // Tablonun tamamını yeniden yazmak yerine yalnız ilgili günün satırlarını değiştir.
    if (matches.length) {
      const groups = [];
      let blockStart = matches[0], prev = matches[0];
      for (let i = 1; i < matches.length; i++) {
        const row = matches[i];
        if (row === prev + 1) prev = row;
        else { groups.push([blockStart, prev - blockStart + 1]); blockStart = prev = row; }
      }
      groups.push([blockStart, prev - blockStart + 1]);
      for (let i = groups.length - 1; i >= 0; i--) sh.deleteRows(groups[i][0], groups[i][1]);
      traceMark_(trace, 'save:old-rows-deleted:' + matches.length);
    }

    if (cleaned.length) {
      const t = now_();
      const rows = cleaned.map(function(it) { return [userId, date, it.t, it.done, it.id, t, it.parentId || '']; });
      sh.getRange(sh.getLastRow() + 1, 1, rows.length, 7).setValues(rows);
      traceMark_(trace, 'save:new-rows-written:' + rows.length);
    }

    const revision = bumpRevision_(userId);
    traceMark_(trace, 'save:revision-after:' + revision);
    // Önceki revision snapshot'ı varsa yalnız değişen günü güncelleyip yeni revision'a taşı.
    // Böylece diğer cihazın bir sonraki sync'i Sheet'i taramadan güncel veriyi alabilir.
    if (beforeSnapshot) {
      const nextSnapshot = JSON.parse(JSON.stringify(beforeSnapshot));
      if (cleaned.length) nextSnapshot[date] = cleaned;
      else delete nextSnapshot[date];
      putRecordsSnapshot_(userId, revision, nextSnapshot);
    }
    const result = { ok: true, revision: revision, previousRevision: beforeRevision, needsSync: needsSync };
    rememberSavedOp_(userId, opId, result);
    traceMark_(trace, 'save:done');
    return result;
  } finally { lock.releaseLock(); }
}


function journalStatusCacheKey_(userId, date) {
  return 'centik-journal-status-v1|' + String(userId || '') + '|' + String(date || '');
}
function getJournalStatusCache_(userId, date) {
  try {
    const v = CacheService.getScriptCache().get(journalStatusCacheKey_(userId, date));
    if (v === '1') return true;
    if (v === '0') return false;
  } catch (e) {}
  return null;
}
function putJournalStatusCache_(userId, date, exists) {
  try { CacheService.getScriptCache().put(journalStatusCacheKey_(userId, date), exists ? '1' : '0', CFG.JOURNAL_STATUS_CACHE_SECONDS); } catch (e) {}
}
function journalMonthCacheKey_(userId, month) {
  return 'centik-journal-month-v1|' + String(userId || '') + '|' + String(month || '');
}
function getJournalMonthCache_(userId, month) {
  try {
    const v = CacheService.getScriptCache().get(journalMonthCacheKey_(userId, month));
    if (v == null) return null;
    const a = JSON.parse(v);
    return Array.isArray(a) ? a : null;
  } catch (e) { return null; }
}
function putJournalMonthCache_(userId, month, dates) {
  try { CacheService.getScriptCache().put(journalMonthCacheKey_(userId, month), JSON.stringify(dates || []), CFG.JOURNAL_STATUS_CACHE_SECONDS); } catch (e) {}
}
function dropJournalMonthCache_(userId, month) {
  try { CacheService.getScriptCache().remove(journalMonthCacheKey_(userId, month)); } catch (e) {}
}
function validJournalDate_(date) { return /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')); }
function validJournalMonth_(month) { return /^\d{4}-\d{2}$/.test(String(month || '')); }

// Çetele metni hiçbir sunucu cache'ine alınmaz. Bu yardımcı yalnız ilgili UserID+Tarih satırını bulur.
function findJournalRows_(userId, date) {
  const sh = journals_(), lastRow = sh.getLastRow(), matches = [];
  if (lastRow <= 1) return { sheet: sh, rows: matches };
  const keys = sh.getRange(2, 1, lastRow - 1, 2).getValues();
  for (let i = 0; i < keys.length; i++) {
    if (String(keys[i][0]) === String(userId) && dateStr_(keys[i][1]) === String(date)) matches.push(i + 2);
  }
  return { sheet: sh, rows: matches };
}

function journalStatus_(b, trace) {
  traceMark_(trace, 'journal-status:start');
  const a = auth_(b.token, trace);
  if (!a) return { ok: false, error: 'oturum' };
  const date = String(b.date || '');
  if (!validJournalDate_(date)) return { ok: false, error: 'tarih' };
  const userId = String(a.user[0]);
  const cached = getJournalStatusCache_(userId, date);
  if (cached !== null) {
    traceMark_(trace, 'journal-status:cache-hit');
    return { ok: true, exists: cached, pinEnabled: journalPinEnabledFromUser_(a.user) };
  }
  const found = findJournalRows_(userId, date);
  const exists = found.rows.length > 0;
  putJournalStatusCache_(userId, date, exists);
  traceMark_(trace, 'journal-status:sheet:' + found.rows.length);
  return { ok: true, exists: exists, pinEnabled: journalPinEnabledFromUser_(a.user) };
}

function journalMonthStatus_(b, trace) {
  traceMark_(trace, 'journal-month-status:start');
  const a = auth_(b.token, trace);
  if (!a) return { ok: false, error: 'oturum' };
  const month = String(b.month || '');
  if (!validJournalMonth_(month)) return { ok: false, error: 'tarih' };
  const userId = String(a.user[0]);
  const cached = getJournalMonthCache_(userId, month);
  if (cached !== null) {
    traceMark_(trace, 'journal-month-status:cache-hit');
    return { ok: true, month: month, dates: cached };
  }
  const sh = journals_(), lastRow = sh.getLastRow(), seen = {};
  if (lastRow > 1) {
    const keys = sh.getRange(2, 1, lastRow - 1, 2).getValues(), prefix = month + '-';
    for (let i = 0; i < keys.length; i++) {
      if (String(keys[i][0]) !== userId) continue;
      const d = dateStr_(keys[i][1]);
      if (d.indexOf(prefix) === 0) seen[d] = true;
    }
  }
  const dates = Object.keys(seen).sort();
  putJournalMonthCache_(userId, month, dates);
  traceMark_(trace, 'journal-month-status:sheet:' + dates.length);
  return { ok: true, month: month, dates: dates };
}

function journalPinFailure_(found, now) {
  const u = found.values, sh = users_();
  let count = Number(u[18]) || 0;
  let first = u[19] instanceof Date ? u[19] : (u[19] ? new Date(u[19]) : null);
  const windowMs = CFG.FAILURE_WINDOW_MINUTES * 60000;
  if (!first || now.getTime() - first.getTime() > windowMs) { count = 0; first = now; }
  count++;
  let locked = '';
  if (count >= CFG.MAX_LOGIN_FAILURES) {
    locked = new Date(now.getTime() + CFG.LOCK_MINUTES * 60000);
    count = 0; first = '';
  }
  sh.getRange(found.row, 19, 1, 3).setValues([[count, first, locked]]);
  return locked;
}
function clearJournalPinFailure_(found) { users_().getRange(found.row, 19, 1, 3).setValues([[0, '', '']]); }

function verifyJournalPin_(userId, pin) {
  const found = findUserById_(String(userId));
  if (!found) return { ok: false, error: 'oturum' };
  const u = found.values;
  if (!journalPinEnabledFromUser_(u)) return { ok: true, enabled: false, found: found };
  if (!validJournalPin_(pin)) return { ok: false, error: 'cetele_pin_gerekli', enabled: true, found: found };
  const now = now_();
  const lockedUntil = u[20] instanceof Date ? u[20] : (u[20] ? new Date(u[20]) : null);
  if (lockedUntil && lockedUntil.getTime() > now.getTime()) return { ok: false, error: 'cetele_pin_kilitli', until: lockedUntil.toISOString(), enabled: true, found: found };
  const candidate = hashJournalPin_(String(pin), String(u[16] || ''));
  if (!safeEq_(candidate, String(u[17] || ''))) {
    const locked = journalPinFailure_(found, now);
    return { ok: false, error: locked ? 'cetele_pin_kilitli' : 'cetele_pin', until: locked ? locked.toISOString() : '', enabled: true, found: found };
  }
  clearJournalPinFailure_(found);
  return { ok: true, enabled: true, found: found };
}

function journalGet_(b, trace) {
  traceMark_(trace, 'journal-get:start');
  const a = auth_(b.token, trace);
  if (!a) return { ok: false, error: 'oturum' };
  const date = String(b.date || '');
  if (!validJournalDate_(date)) return { ok: false, error: 'tarih' };
  const userId = String(a.user[0]);
  const access = verifyJournalPin_(userId, b.pin);
  if (!access.ok) return { ok: false, error: access.error, until: access.until || '', pinEnabled: !!access.enabled };
  const found = findJournalRows_(userId, date);
  let content = '', updatedAt = '';
  if (found.rows.length) {
    const row = found.rows[found.rows.length - 1];
    const v = found.sheet.getRange(row, 3, 1, 2).getValues()[0];
    content = String(v[0] || '').slice(0, CFG.JOURNAL_MAX_CHARS);
    updatedAt = v[1] instanceof Date ? v[1].toISOString() : String(v[1] || '');
  }
  const exists = !!content.trim();
  putJournalStatusCache_(userId, date, exists);
  traceMark_(trace, 'journal-get:done:' + (exists ? '1' : '0'));
  return { ok: true, date: date, exists: exists, content: content, updatedAt: updatedAt, pinEnabled: !!access.enabled };
}

function journalSave_(b, trace) {
  traceMark_(trace, 'journal-save:start');
  const a = auth_(b.token, trace);
  if (!a) return { ok: false, error: 'oturum' };
  const date = String(b.date || '');
  if (!validJournalDate_(date)) return { ok: false, error: 'tarih' };
  const userId = String(a.user[0]);
  const access = verifyJournalPin_(userId, b.pin);
  if (!access.ok) return { ok: false, error: access.error, until: access.until || '', pinEnabled: !!access.enabled };
  let content = String(b.content == null ? '' : b.content).replace(/\r\n?/g, '\n');
  if (content.length > CFG.JOURNAL_MAX_CHARS) return { ok: false, error: 'cetele_uzun' };
  const hasContent = !!content.trim();
  if (!hasContent) return { ok: false, error: 'cetele_bos', pinEnabled: !!access.enabled };
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(12000)) return { ok: false, error: 'mesgul' };
  try {
    const found = findJournalRows_(userId, date), sh = found.sheet;
    if (found.rows.length) {
      // Aynı tarih için yalnız tek kayıt bırakılır. Aşağıdan yukarı silmek satır numaralarını korur.
      found.rows.slice().sort(function(x, y) { return y - x; }).forEach(function(row) { sh.deleteRow(row); });
    }
    if (hasContent) sh.appendRow([userId, date, content, now_()]);
    putJournalStatusCache_(userId, date, hasContent);
    dropJournalMonthCache_(userId, date.slice(0, 7));
    traceMark_(trace, 'journal-save:done:' + (hasContent ? '1' : '0'));
    return { ok: true, exists: hasContent, pinEnabled: !!access.enabled, updatedAt: hasContent ? new Date().toISOString() : '' };
  } finally { lock.releaseLock(); }
}

function journalPinSet_(b, trace) {
  traceMark_(trace, 'journal-pin-set:start');
  const a = auth_(b.token, trace);
  if (!a) return { ok: false, error: 'oturum' };
  const userId = String(a.user[0]), newPin = String(b.newPin || ''), currentPin = String(b.currentPin || '');
  if (!validJournalPin_(newPin)) return { ok: false, error: 'cetele_pin_bicim' };
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const found = findUserById_(userId);
    if (!found) return { ok: false, error: 'oturum' };
    if (journalPinEnabledFromUser_(found.values)) {
      const access = verifyJournalPin_(userId, currentPin);
      if (!access.ok) return { ok: false, error: access.error, until: access.until || '' };
    }
    const salt = randomHex_(16), hash = hashJournalPin_(newPin, salt), t = now_();
    users_().getRange(found.row, 17, 1, 5).setValues([[salt, hash, 0, '', '']]);
    users_().getRange(found.row, 8).setValue(t);
    invalidateUserAuthCaches_(userId);
    traceMark_(trace, 'journal-pin-set:done');
    return { ok: true, pinEnabled: true };
  } finally { lock.releaseLock(); }
}

function journalPinDisable_(b, trace) {
  traceMark_(trace, 'journal-pin-disable:start');
  const a = auth_(b.token, trace);
  if (!a) return { ok: false, error: 'oturum' };
  const userId = String(a.user[0]);
  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  try {
    const found = findUserById_(userId);
    if (!found) return { ok: false, error: 'oturum' };
    if (!journalPinEnabledFromUser_(found.values)) return { ok: true, pinEnabled: false };
    const access = verifyJournalPin_(userId, String(b.currentPin || ''));
    if (!access.ok) return { ok: false, error: access.error, until: access.until || '' };
    users_().getRange(found.row, 17, 1, 5).setValues([['', '', 0, '', '']]);
    users_().getRange(found.row, 8).setValue(now_());
    invalidateUserAuthCaches_(userId);
    traceMark_(trace, 'journal-pin-disable:done');
    return { ok: true, pinEnabled: false };
  } finally { lock.releaseLock(); }
}


// ——— Çakılı: tarihten bağımsız, en fazla bir kullanıcıyla ortak düzenlenebilen listeler ———
function cleanPinnedTitle_(v) { return String(v || '').trim().replace(/\s+/g, ' ').slice(0, 100); }
function cleanPinnedText_(v) { return String(v || '').trim().slice(0, 1000); }
function pinnedFindList_(listId) {
  const id = String(listId || '').trim();
  if (!id) return null;
  const sh = pinnedListsSheet_(), last = sh ? sh.getLastRow() : 0;
  if (!sh || last < 2) return null;
  const v = sh.getRange(2, 1, last - 1, 7).getValues();
  for (let i = 0; i < v.length; i++) if (String(v[i][0]) === id) return { row: i + 2, values: v[i] };
  return null;
}
function pinnedAccess_(listId, userId) {
  const found = pinnedFindList_(listId);
  if (!found) return null;
  const owner = String(found.values[1] || ''), shared = String(found.values[3] || '');
  const uid = String(userId || '');
  if (uid !== owner && uid !== shared) return null;
  return { found: found, owner: owner, shared: shared, isOwner: uid === owner };
}
function pinnedUserMini_(userId) {
  if (!userId) return null;
  const f = findUserById_(userId);
  if (!f) return null;
  return { id: String(f.values[0] || ''), email: String(f.values[1] || ''), name: String(f.values[2] || '') };
}
function pinnedPublicList_(values, viewerId) {
  const ownerId = String(values[1] || ''), sharedId = String(values[3] || '');
  return {
    id: String(values[0] || ''),
    title: String(values[2] || ''),
    ownerId: ownerId,
    isOwner: String(viewerId || '') === ownerId,
    owner: pinnedUserMini_(ownerId),
    sharedUser: pinnedUserMini_(sharedId),
    updatedAt: values[5] instanceof Date ? values[5].toISOString() : String(values[5] || ''),
    revision: Math.max(0, Math.floor(Number(values[6]) || 0))
  };
}
function pinnedBumpList_(row, currentValues) {
  const sh = pinnedListsSheet_(), now = now_(), next = Math.max(0, Math.floor(Number(currentValues[6]) || 0)) + 1;
  sh.getRange(row, 6, 1, 2).setValues([[now, next]]);
  currentValues[5] = now; currentValues[6] = next;
  return next;
}
function pinnedListsApi_(b, trace) {
  const a = auth_(b.token, trace);
  if (!a) return { ok: false, error: 'oturum' };
  const userId = String(a.user[0]), sh = pinnedListsSheet_(), out = [];
  if (sh && sh.getLastRow() > 1) {
    const v = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
    v.forEach(function(r) {
      if (String(r[1] || '') === userId || String(r[3] || '') === userId) out.push(pinnedPublicList_(r, userId));
    });
  }
  out.sort(function(x, y) { return String(y.updatedAt || '').localeCompare(String(x.updatedAt || '')); });
  return { ok: true, lists: out };
}
function pinnedCreate_(b, trace) {
  const a = auth_(b.token, trace);
  if (!a) return { ok: false, error: 'oturum' };
  const title = cleanPinnedTitle_(b.title);
  if (!title) return { ok: false, error: 'cakili_baslik' };
  const lock = LockService.getScriptLock(); lock.waitLock(12000);
  try {
    const id = Utilities.getUuid(), now = now_(), userId = String(a.user[0]);
    const row = [id, userId, title, '', now, now, 1];
    pinnedListsSheet_().appendRow(row);
    return { ok: true, list: pinnedPublicList_(row, userId) };
  } finally { lock.releaseLock(); }
}
function pinnedRename_(b, trace) {
  const a = auth_(b.token, trace);
  if (!a) return { ok: false, error: 'oturum' };
  const title = cleanPinnedTitle_(b.title);
  if (!title) return { ok: false, error: 'cakili_baslik' };
  const lock = LockService.getScriptLock(); lock.waitLock(12000);
  try {
    const access = pinnedAccess_(b.listId, String(a.user[0]));
    if (!access) return { ok: false, error: 'cakili_yetki' };
    pinnedListsSheet_().getRange(access.found.row, 3).setValue(title);
    access.found.values[2] = title; pinnedBumpList_(access.found.row, access.found.values);
    return { ok: true, list: pinnedPublicList_(access.found.values, String(a.user[0])) };
  } finally { lock.releaseLock(); }
}
function pinnedDelete_(b, trace) {
  const a = auth_(b.token, trace);
  if (!a) return { ok: false, error: 'oturum' };
  const lock = LockService.getScriptLock(); lock.waitLock(12000);
  try {
    const access = pinnedAccess_(b.listId, String(a.user[0]));
    if (!access) return { ok: false, error: 'cakili_yetki' };
    const listId = String(access.found.values[0]), tsh = pinnedTasksSheet_();
    if (tsh && tsh.getLastRow() > 1) {
      const ids = tsh.getRange(2, 1, tsh.getLastRow() - 1, 1).getValues(), del = [];
      ids.forEach(function(r, i) { if (String(r[0]) === listId) del.push(i + 2); });
      del.sort(function(x, y) { return y - x; }).forEach(function(row) { tsh.deleteRow(row); });
    }
    pinnedListsSheet_().deleteRow(access.found.row);
    return { ok: true };
  } finally { lock.releaseLock(); }
}
function pinnedShare_(b, trace) {
  const a = auth_(b.token, trace);
  if (!a) return { ok: false, error: 'oturum' };
  const email = normalizeEmail_(b.email || '');
  const lock = LockService.getScriptLock(); lock.waitLock(12000);
  try {
    const access = pinnedAccess_(b.listId, String(a.user[0]));
    if (!access) return { ok: false, error: 'cakili_yetki' };
    if (!access.isOwner) return { ok: false, error: 'cakili_sahip' };
    let sharedId = '';
    if (email) {
      if (!validEmail_(email)) return { ok: false, error: 'eposta' };
      const target = findUserByEmail_(email);
      if (!target || String(target.values[5] || '') !== 'aktif') return { ok: false, error: 'cakili_kullanici' };
      sharedId = String(target.values[0] || '');
      if (!sharedId || sharedId === String(a.user[0])) return { ok: false, error: 'cakili_kendin' };
    }
    pinnedListsSheet_().getRange(access.found.row, 4).setValue(sharedId);
    access.found.values[3] = sharedId; pinnedBumpList_(access.found.row, access.found.values);
    return { ok: true, list: pinnedPublicList_(access.found.values, String(a.user[0])) };
  } finally { lock.releaseLock(); }
}
function pinnedReadTasks_(listId) {
  const sh = pinnedTasksSheet_(), out = [];
  if (!sh || sh.getLastRow() < 2) return out;
  const v = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
  v.forEach(function(r, i) {
    if (String(r[0]) !== String(listId)) return;
    const id = String(r[1] || '').trim(), text = cleanPinnedText_(r[2]);
    if (!id || !text) return;
    out.push({ id: id, t: text, done: r[3] === true || String(r[3]).toUpperCase() === 'TRUE', parentId: String(r[4] || '').trim().slice(0, 80), order: Number(r[5]) || (i + 1) });
  });
  out.sort(function(x, y) { return x.order - y.order; });
  const cleaned = dedupeItems_(out);
  return cleaned;
}
function pinnedGet_(b, trace) {
  const a = auth_(b.token, trace);
  if (!a) return { ok: false, error: 'oturum' };
  const userId = String(a.user[0]), access = pinnedAccess_(b.listId, userId);
  if (!access) return { ok: false, error: 'cakili_yetki' };
  const revision = Math.max(0, Math.floor(Number(access.found.values[6]) || 0)), known = Number(b.knownRevision);
  if (b.knownRevision !== '' && b.knownRevision !== null && b.knownRevision !== undefined && Number.isFinite(known) && Math.floor(known) === revision) {
    return { ok: true, unchanged: true, revision: revision, list: pinnedPublicList_(access.found.values, userId) };
  }
  return { ok: true, unchanged: false, revision: revision, list: pinnedPublicList_(access.found.values, userId), tasks: pinnedReadTasks_(String(access.found.values[0])) };
}
function pinnedTaskRows_(listId) {
  const sh = pinnedTasksSheet_(), out = [];
  if (!sh || sh.getLastRow() < 2) return out;
  const v = sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues();
  v.forEach(function(r, i) { if (String(r[0]) === String(listId)) out.push({ row: i + 2, values: r }); });
  return out;
}
function pinnedTaskMutate_(b, trace) {
  const a = auth_(b.token, trace);
  if (!a) return { ok: false, error: 'oturum' };
  const userId = String(a.user[0]), kind = String(b.kind || ''), listId = String(b.listId || '').trim();
  if (!listId) return { ok: false, error: 'cakili_liste' };
  const lock = LockService.getScriptLock(); lock.waitLock(12000);
  try {
    const access = pinnedAccess_(listId, userId);
    if (!access) return { ok: false, error: 'cakili_yetki' };
    const sh = pinnedTasksSheet_(), rows = pinnedTaskRows_(listId), byId = Object.create(null);
    rows.forEach(function(x) { byId[String(x.values[1] || '')] = x; });
    if (kind === 'add') {
      const taskId = String(b.taskId || '').trim().slice(0, 80), text = cleanPinnedText_(b.text);
      if (!taskId || !text) return { ok: false, error: 'cakili_gorev' };
      if (!byId[taskId]) {
        let maxOrder = 0; rows.forEach(function(x) { maxOrder = Math.max(maxOrder, Number(x.values[5]) || 0); });
        sh.appendRow([listId, taskId, text, false, '', maxOrder + 1, now_()]);
      }
    } else if (kind === 'toggle') {
      const x = byId[String(b.taskId || '')]; if (!x) return { ok: false, error: 'cakili_gorev_yok' };
      const next = !!b.done;
      sh.getRange(x.row, 4).setValue(next); sh.getRange(x.row, 7).setValue(now_());
    } else if (kind === 'update') {
      const x = byId[String(b.taskId || '')], text = cleanPinnedText_(b.text); if (!x) return { ok: false, error: 'cakili_gorev_yok' }; if (!text) return { ok: false, error: 'cakili_gorev' };
      sh.getRange(x.row, 3).setValue(text); sh.getRange(x.row, 7).setValue(now_());
    } else if (kind === 'delete') {
      const id = String(b.taskId || ''), root = byId[id]; if (!root) return { ok: false, error: 'cakili_gorev_yok' };
      const ids = Object.create(null); ids[id] = true; let added = true;
      while (added) { added = false; rows.forEach(function(x) { const tid = String(x.values[1] || ''), pid = String(x.values[4] || ''); if (pid && ids[pid] && !ids[tid]) { ids[tid] = true; added = true; } }); }
      rows.filter(function(x) { return ids[String(x.values[1] || '')]; }).map(function(x) { return x.row; }).sort(function(x, y) { return y - x; }).forEach(function(row) { sh.deleteRow(row); });
    } else if (kind === 'reorder') {
      const items = Array.isArray(b.items) ? b.items.slice(0, 200) : [];
      const seen = Object.create(null); let order = 1;
      items.forEach(function(it) {
        const id = String(it && it.id || ''), x = byId[id]; if (!x || seen[id]) return; seen[id] = true;
        let pid = String(it && it.parentId || '').trim().slice(0, 80); if (pid === id || !byId[pid]) pid = '';
        sh.getRange(x.row, 5, 1, 3).setValues([[pid, order++, now_()]]);
      });
      rows.forEach(function(x) { const id = String(x.values[1] || ''); if (seen[id]) return; sh.getRange(x.row, 6, 1, 2).setValues([[order++, now_()]]); });
    } else return { ok: false, error: 'islem' };
    const revision = pinnedBumpList_(access.found.row, access.found.values);
    return { ok: true, revision: revision, list: pinnedPublicList_(access.found.values, userId), tasks: pinnedReadTasks_(listId) };
  } finally { lock.releaseLock(); }
}

function expectedHeaders_() {
  return {
    records: ['UserID', 'Tarih', 'Görev', 'Tamamlandı', 'ID', 'Güncelleme', 'ParentID'],
    users: ['UserID','Email','Ad','Salt','PasswordHash','Durum','CreatedAt','UpdatedAt','FailedCount','FirstFailedAt','LockedUntil','ResetHash','ResetUntil','Rol','OnayZamani','Tema','CetelePinSalt','CetelePinHash','CetelePinFailedCount','CetelePinFirstFailedAt','CetelePinLockedUntil'],
    sessions: ['TokenHash','UserID','ExpiresAt','CreatedAt','LastSeen'],
    journals: ['UserID','Tarih','Icerik','UpdatedAt'],
    pinnedLists: ['ListID','OwnerUserID','Baslik','SharedUserID','CreatedAt','UpdatedAt','Revision'],
    pinnedTasks: ['ListID','TaskID','Gorev','Tamamlandi','ParentID','Sira','UpdatedAt']
  };
}
function headersMatch_(sh, expected) {
  if (!sh) return false;
  const got = sh.getRange(1, 1, 1, expected.length).getValues()[0].map(String);
  return expected.every(function(h, i) { return got[i] === h; });
}
function regressionSnapshot_(trace) {
  const started = Date.now(), ss = ss_();
  traceMark_(trace, 'diag:spreadsheet-open');
  const rec = ss.getSheetByName(CFG.RECORDS_SHEET), usr = ss.getSheetByName(CFG.USERS_SHEET), ses = ss.getSheetByName(CFG.SESSIONS_SHEET), jou = ss.getSheetByName(CFG.JOURNAL_SHEET), pinLists = ss.getSheetByName(CFG.PINNED_LISTS_SHEET), pinTasks = ss.getSheetByName(CFG.PINNED_TASKS_SHEET);
  const h = expectedHeaders_();
  const checks = {
    spreadsheet: !!ss,
    recordsSheet: !!rec,
    usersSheet: !!usr,
    sessionsSheet: !!ses,
    journalsSheet: !!jou,
    pinnedListsSheet: !!pinLists,
    pinnedTasksSheet: !!pinTasks,
    recordsHeaders: headersMatch_(rec, h.records),
    usersHeaders: headersMatch_(usr, h.users),
    sessionsHeaders: headersMatch_(ses, h.sessions),
    journalsHeaders: headersMatch_(jou, h.journals),
    pinnedListsHeaders: headersMatch_(pinLists, h.pinnedLists),
    pinnedTasksHeaders: headersMatch_(pinTasks, h.pinnedTasks),
    adminConfigured: !!adminEmail_()
  };
  traceMark_(trace, 'diag:headers');
  let duplicateCount = 0, recordCount = 0;
  if (rec && rec.getLastRow() > 1) {
    const v = rec.getRange(2, 1, rec.getLastRow() - 1, 6).getValues();
    recordCount = v.length;
    const seen = Object.create(null);
    v.forEach(function(r) {
      const k = String(r[0] || '') + '\u001f' + dateStr_(r[1]) + '\u001f' + String(r[4] || '');
      if (!r[0] || !r[1] || !r[4]) return;
      if (seen[k]) duplicateCount++; else seen[k] = true;
    });
  }
  traceMark_(trace, 'diag:records-scan:' + recordCount);
  const usersRows = usr ? Math.max(0, usr.getLastRow() - 1) : 0;
  const sessionRows = ses ? Math.max(0, ses.getLastRow() - 1) : 0;
  const journalRows = jou ? Math.max(0, jou.getLastRow() - 1) : 0;
  const pinnedListRows = pinLists ? Math.max(0, pinLists.getLastRow() - 1) : 0;
  const pinnedTaskRows = pinTasks ? Math.max(0, pinTasks.getLastRow() - 1) : 0;
  let adminOk = false;
  if (usr && usersRows) {
    const v = usr.getDataRange().getValues();
    for (let i = 1; i < v.length; i++) if (isSuperAdminEmail_(v[i][1]) && isAdminUser_(v[i])) { adminOk = true; break; }
  }
  checks.adminAccount = adminOk;
  checks.noDuplicateRecords = duplicateCount === 0;
  const ok = Object.keys(checks).every(function(k) { return checks[k] === true; });
  return {
    ok: ok,
    build: CENTIK_SERVER_BUILD,
    api: CENTIK_API_VERSION,
    spreadsheetId: ss.getId(),
    counts: { records: recordCount, users: usersRows, sessions: sessionRows, journals: journalRows, pinnedLists: pinnedListRows, pinnedTasks: pinnedTaskRows, duplicates: duplicateCount },
    checks: checks,
    elapsedMs: Date.now() - started,
    serverTime: new Date().toISOString()
  };
}
function diagnostics_(b, trace) {
  const a = auth_(b.token, trace);
  if (!a) return { ok: false, error: 'oturum' };
  if (!isAdminUser_(a.user)) return { ok: false, error: 'yetki' };
  const result = regressionSnapshot_(trace);
  // API sözleşmesinde ok=true çağrının başarıyla işlendiğini ifade eder;
  // testlerin toplu sonucu healthOk alanındadır.
  return { ok: true, healthOk: result.ok, report: result };
}

/**
 * Apps Script editöründen elle çalıştırılabilen, veri değiştirmeyen regresyon testi.
 * Sonucu Çalıştırma günlüğüne JSON olarak yazar ve aynı nesneyi döndürür.
 */
function centikRegresyonTesti() {
  const trace = traceStart_('manualRegression', { clientBuild: 'apps-script-editor' });
  const result = regressionSnapshot_(trace);
  result.trace = traceFinish_(trace);
  console.log(JSON.stringify(result));
  return result;
}

/**
 * Bir defalık bakım aracı.
 * Aynı UserID + Tarih + ID anahtarına sahip mükerrer Kayitlar satırlarında
 * Güncelleme zamanı en yeni olan satırı korur, eskileri siler.
 * Silme öncesinde Kayitlar sayfasının yedeğini oluşturur.
 * Apps Script editöründen elle bir kez çalıştırılabilir.
 */
function mukerrerKayitlariTemizle() {
  ensureSchema_();
  const lock = LockService.getScriptLock(); lock.waitLock(30000);
  try {
    const sh = records_(), lastRow = sh.getLastRow();
    if (lastRow <= 2) return { ok: true, deleted: 0, backup: '' };
    const rows = sh.getRange(2, 1, lastRow - 1, 6).getValues(), best = Object.create(null), removeRows = [], affected = Object.create(null);
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i], userId = String(r[0] || ''), d = r[1] ? dateStr_(r[1]) : '', id = String(r[4] || '').trim();
      if (!userId || !d || !id) continue;
      const k = userId + '\u001f' + d + '\u001f' + id, rowNo = i + 2, stamp = updatedMs_(r[5], rowNo), prev = best[k];
      if (!prev) { best[k] = { row: rowNo, stamp: stamp, userId: userId }; continue; }
      if (stamp > prev.stamp || (stamp === prev.stamp && rowNo > prev.row)) {
        removeRows.push(prev.row); affected[prev.userId] = true; best[k] = { row: rowNo, stamp: stamp, userId: userId };
      } else {
        removeRows.push(rowNo); affected[userId] = true;
      }
    }
    if (!removeRows.length) return { ok: true, deleted: 0, backup: '' };

    const ss = ss_(), stampName = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd_HHmmss');
    let backupName = 'Kayitlar_MukerrerYedek_' + stampName, suffix = 1;
    while (ss.getSheetByName(backupName)) backupName = 'Kayitlar_MukerrerYedek_' + stampName + '_' + (suffix++);
    sh.copyTo(ss).setName(backupName);

    removeRows.sort(function(a, b) { return b - a; }).forEach(function(row) { sh.deleteRow(row); });
    Object.keys(affected).forEach(function(userId) { bumpRevision_(userId); });
    return { ok: true, deleted: removeRows.length, backup: backupName, affectedUsers: Object.keys(affected).length };
  } finally { lock.releaseLock(); }
}

function adminAuth_(token, trace) {
  traceMark_(trace, 'admin-auth:start');
  const a = auth_(token, trace);
  if (!a || !isAdminUser_(a.user)) {
    traceMark_(trace, 'admin-auth:denied');
    return null;
  }
  traceMark_(trace, 'admin-auth:ok');
  return a;
}

function adminPending_(b, trace) {
  const a = adminAuth_(b.token, trace);
  if (!a) return { ok: false, error: 'yetki' };
  const cache = CacheService.getScriptCache();
  let wasCached = false;
  try { wasCached = !!cache.get(adminPendingCacheKey_()); } catch (e) {}
  const snapshot = pendingApprovalsSnapshot_();
  traceMark_(trace, wasCached ? 'admin-pending:cache-hit' : 'admin-pending:cache-miss');
  traceMark_(trace, 'admin-pending:count:' + snapshot.count);
  return { ok: true, users: snapshot.users, count: snapshot.count, maxPending: snapshot.maxPending, maxUsers: snapshot.maxUsers };
}

function adminUsers_(b, trace) {
  const a = adminAuth_(b.token, trace);
  if (!a) return { ok: false, error: 'yetki' };
  const cache = CacheService.getScriptCache();
  let wasCached = false;
  try { wasCached = !!cache.get(adminUsersCacheKey_()); } catch (e) {}
  const snapshot = registeredUsersSnapshot_();
  traceMark_(trace, wasCached ? 'admin-users:cache-hit' : 'admin-users:cache-miss');
  traceMark_(trace, 'admin-users:count:' + snapshot.count);
  return { ok: true, users: snapshot.users, count: snapshot.count, maxUsers: snapshot.maxUsers };
}

function adminSetStatus_(b, trace) {
  const a = adminAuth_(b.token, trace);
  if (!a) return { ok: false, error: 'yetki' };
  const userId = String(b.userId || '');
  const next = String(b.status || '');
  if (next !== 'aktif' && next !== 'reddedildi') return { ok: false, error: 'durum' };

  const lock = LockService.getScriptLock(); lock.waitLock(15000);
  traceMark_(trace, 'admin-status:lock');
  try {
    const found = findUserById_(userId);
    traceMark_(trace, 'admin-status:user-read');
    if (!found) return { ok: false, error: 'kullanici_yok' };
    const u = found.values;
    if (isSuperAdminEmail_(u[1])) return { ok: false, error: 'yetki' };
    if (String(u[5]) !== 'bekliyor') return { ok: false, error: 'durum' };

    const t = now_();
    const sh = users_();
    sh.getRange(found.row, 6).setValue(next);
    sh.getRange(found.row, 8).setValue(t);
    if (next === 'aktif') sh.getRange(found.row, 15).setValue(t);
    revokeUserSessions_(userId);
    invalidateAdminPendingCache_();
    invalidateAdminUsersCache_();
    traceMark_(trace, 'admin-status:written');

    try {
      MailApp.sendEmail({
        to: String(u[1]),
        subject: next === 'aktif' ? 'Çentik hesabınız onaylandı' : 'Çentik hesap başvurunuz',
        htmlBody: next === 'aktif'
          ? '<p>Çentik hesap başvurunuz onaylandı. Artık e-posta adresiniz ve parolanızla giriş yapabilirsiniz.</p>'
          : '<p>Çentik hesap başvurunuz yönetici tarafından onaylanmadı.</p>',
        name: 'Çentik'
      });
      traceMark_(trace, 'admin-status:mail');
    } catch (err) {
      console.error('Approval mail failed: ' + err);
      traceMark_(trace, 'admin-status:mail-failed');
    }
    return { ok: true, status: next };
  } finally { lock.releaseLock(); }
}

function resetRequest_(b) {
  const email = normalizeEmail_(b.email);
  if (!validEmail_(email)) return { ok: true }; // hesap var/yok bilgisini sızdırma
  const found = findUserByEmail_(email);
  if (!found || String(found.values[5]) !== 'aktif') return { ok: true };

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const hash = sha256_(code + '|' + email + '|' + pepper_());
  const until = new Date(Date.now() + CFG.RESET_MINUTES * 60000);
  users_().getRange(found.row, 12, 1, 2).setValues([[hash, until]]);

  try {
    MailApp.sendEmail({
      to: email,
      subject: 'Çentik parola sıfırlama kodu',
      htmlBody: '<p>Çentik parola sıfırlama kodunuz:</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">' + code + '</p><p>Kod ' + CFG.RESET_MINUTES + ' dakika geçerlidir. Bu isteği siz yapmadıysanız e-postayı yok sayın.</p>',
      name: 'Çentik'
    });
  } catch (err) {
    console.error('Mail send failed: ' + err);
    return { ok: false, error: 'eposta_gonderilemedi' };
  }
  return { ok: true };
}

function resetConfirm_(b) {
  const email = normalizeEmail_(b.email);
  const code = String(b.code || '').trim();
  const password = String(b.password || '');
  if (!validEmail_(email) || !/^\d{6}$/.test(code) || !validPassword_(password)) return { ok: false, error: 'sifirlama' };
  const found = findUserByEmail_(email);
  if (!found) return { ok: false, error: 'sifirlama' };
  const u = found.values;
  const until = u[12] instanceof Date ? u[12] : (u[12] ? new Date(u[12]) : null);
  const candidate = sha256_(code + '|' + email + '|' + pepper_());
  if (!until || until.getTime() < Date.now() || !safeEq_(candidate, String(u[11]))) return { ok: false, error: 'sifirlama' };

  const salt = randomHex_(16);
  const h = hashPassword_(password, salt);
  const sh = users_();
  sh.getRange(found.row, 4, 1, 2).setValues([[salt, h]]);
  sh.getRange(found.row, 8).setValue(now_());
  sh.getRange(found.row, 12, 1, 2).setValues([['', '']]);
  clearFailedLogin_(found.row);
  revokeUserSessions_(String(u[0]));
  return { ok: true };
}

function revokeUserSessions_(userId) {
  const sh = sessions_();
  const v = sh.getDataRange().getValues();
  for (let i = v.length - 1; i >= 1; i--) {
    if (String(v[i][1]) !== userId) continue;
    invalidateAuthHash_(String(v[i][0] || ''));
    sh.deleteRow(i + 1);
  }
}
