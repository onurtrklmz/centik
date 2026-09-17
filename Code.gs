// Günlük kayıt sitesi için Google E-Tablo arka ucu.
// E-Tablo > Uzantılar > Apps Script'e yapıştır, TOKEN'ı değiştir,
// Dağıt > Yeni dağıtım > Web uygulaması (Yürüten: Ben, Erişim: Herkes).

const TOKEN = 'BURAYA-UZUN-BIR-SIFRE-YAZ';
const SHEET = 'Kayitlar';

function sheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET);
  if (!sh) {
    sh = ss.insertSheet(SHEET);
    sh.appendRow(['Tarih', 'Görev', 'Tamamlandı', 'ID', 'Güncelleme']);
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('@'); // tarih metin olarak kalsın
  }
  return sh;
}

function dateStr_(v) {
  return v instanceof Date
    ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd')
    : String(v);
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}

// Tüm kayıtları oku
function doGet(e) {
  if (e.parameter.token !== TOKEN) return out_({ ok: false, error: 'yetki' });
  const v = sheet_().getDataRange().getValues();
  const days = {};
  for (let i = 1; i < v.length; i++) {
    const r = v[i];
    if (!r[0]) continue;
    const d = dateStr_(r[0]);
    (days[d] = days[d] || []).push({
      id: String(r[3]),
      t: String(r[1]),
      done: r[2] === true || String(r[2]).toUpperCase() === 'TRUE'
    });
  }
  return out_({ ok: true, days });
}

// Bir günün listesini baştan yaz
function doPost(e) {
  let b;
  try { b = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'bicim' }); }
  if (b.token !== TOKEN) return out_({ ok: false, error: 'yetki' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '')) return out_({ ok: false, error: 'tarih' });

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = sheet_();
    const v = sh.getDataRange().getValues();
    const rows = v.slice(1)
      .filter(r => r[0] && dateStr_(r[0]) !== b.date)
      .map(r => [dateStr_(r[0]), r[1], r[2], r[3], r[4]]);
    const now = new Date();
    (b.items || []).forEach(it => rows.push([b.date, String(it.t), !!it.done, String(it.id), now]));
    rows.sort((a, c) => (a[0] < c[0] ? -1 : a[0] > c[0] ? 1 : 0));

    if (sh.getLastRow() > 1) sh.getRange(2, 1, sh.getLastRow() - 1, 5).clearContent();
    if (rows.length) sh.getRange(2, 1, rows.length, 5).setValues(rows);
    return out_({ ok: true });
  } finally {
    lock.releaseLock();
  }
}
