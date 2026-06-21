// ============================================================
// WHISPERING TAROT v4 — Code.gs
// GAS handles: Auth, Mailbox (scheduled clues), Scores, Announcements
// Firebase handles: All real-time chat
// ============================================================

const ADMIN_PASS = "tarotadmin6202";
const SH_SENIORS = "Seniors_Data";
const SH_JUNIORS = "Juniors_Data";
const SH_MAILBOX = "Dynamic_Mailbox";
const SH_CONFIG  = "Config";

// ── FIREBASE CONFIG ──────────────────────────────────────────
// TODO: Fill these in from your Firebase project settings
// Firebase console → Project settings → Your apps → Web app config
const FB_CONFIG = {
  apiKey: "AIzaSyAJnGnl0WFWBVsVbOmdZ0zvMuBOjyN9D8A",
  authDomain: "whispering-tarot.firebaseapp.com",
  databaseURL: "https://whispering-tarot-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "whispering-tarot",
  storageBucket: "whispering-tarot.firebasestorage.app",
  messagingSenderId: "699896129038",
  appId: "1:699896129038:web:7ad0518eddd028c0de3e5f",
  measurementId: "G-XJK8M86GQ5"
};

// ── Entry point ──────────────────────────────────────────────
function doGet() {
  return HtmlService
    .createHtmlOutputFromFile("index")
    .setTitle("✦ Whispering Tarot ✦")
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ── Sheet helpers ────────────────────────────────────────────
// ═══════════════════════════════════════════════
// TODO: วาง Spreadsheet ID ของนายตรงนี้
// วิธีหา: เปิด Google Sheet → ดู URL
// https://docs.google.com/spreadsheets/d/ [ID อยู่ตรงนี้] /edit
// ═══════════════════════════════════════════════
const SPREADSHEET_ID = "17BbG_khiYeX16S-pfn56bsYvXrRu92o409oZpwAuDQI";

function ss() {
  return SpreadsheetApp.openById(SPREADSHEET_ID);
}
function sh(n) {
  return ss().getSheetByName(n) || ss().insertSheet(n);
}
function sheetRows(name) {
  const s = ss().getSheetByName(name);
  if (!s || s.getLastRow() < 1) return { head:[], rows:[] };
  const d = s.getDataRange().getValues();
  return { head: d[0] || [], rows: d.slice(1) };
}
function rowToObj(head, row) {
  const o = {};
  head.forEach((h,i) => { o[String(h)] = row[i] ?? ""; });
  return o;
}

// ── Config ───────────────────────────────────────────────────
function getConfig(key) {
  const { head, rows } = sheetRows(SH_CONFIG);
  const ki=head.indexOf("key"), vi=head.indexOf("value");
  if (ki<0) return null;
  for (const r of rows) if (String(r[ki])===key) return r[vi];
  return null;
}
function setConfig(key, val) {
  const s = sh(SH_CONFIG);
  if (s.getLastRow()===0) s.appendRow(["key","value"]);
  const data = s.getDataRange().getValues();
  const ki=data[0].indexOf("key"), vi=data[0].indexOf("value");
  for (let i=1;i<data.length;i++) {
    if (String(data[i][ki])===key) { s.getRange(i+1,vi+1).setValue(val); return; }
  }
  s.appendRow([key, val]);
}

// ── Prefix helper ────────────────────────────────────────────
function withPrefix(name, role) {
  const n = String(name||"").trim();
  if (role==="senior") return n.startsWith("พี่") ? n : "พี่"+n;
  if (role==="junior") return n.startsWith("น้อง") ? n : "น้อง"+n;
  return n;
}

// ── Auth ─────────────────────────────────────────────────────
function handleLogin(username, password) {
  try {
    const u=String(username), p=String(password);

    // Admin
    if ((u === '01100101' || /^admin\d*$/.test(u)) && p===ADMIN_PASS) {
      recordLogin(u);
      return { success:true, role:"admin", name:"Admin", id:u, fbConfig:FB_CONFIG };
    }

    // Junior
    const { head:jh, rows:jr } = sheetRows(SH_JUNIORS);
    for (const r of jr) {
      const o = rowToObj(jh,r);
      if (String(o.id)===u) {
        if (String(o.password)===p) {
          recordLogin(u);
          return { success:true, role:"junior", id:u, pass:p,
            name: withPrefix(o.name,"junior"),
            rawName: o.name,
            tarot:o.tarot, fbConfig:FB_CONFIG };
        }
        return { success:false, message:"รหัสผ่านไม่ถูกต้อง" };
      }
    }
    // Senior
    const { head:sh2, rows:sr } = sheetRows(SH_SENIORS);
    for (const r of sr) {
      const o = rowToObj(sh2,r);
      if (String(o.id)===u) {
        if (String(o.password)===p) {
          // Also get junior name for senior's back-of-card display
          const { head:jh2, rows:jr2 } = sheetRows(SH_JUNIORS);
          const jRow = jr2.find(j => rowToObj(jh2,j).tarot===o.tarot);
          const juniorName = jRow ? withPrefix(rowToObj(jh2,jRow).name,"junior") : "ยังไม่ได้รับน้อง";
          recordLogin(u);
          return { success:true, role:"senior", id:u, pass:p,
            name: withPrefix(o.name,"senior"),
            rawName: o.name,
            tarot:o.tarot, juniorName, fbConfig:FB_CONFIG };
        }
        return { success:false, message:"รหัสผ่านไม่ถูกต้อง" };
      }
    }
    return { success:false, message:"ไม่พบชื่อผู้ใช้งานหรือรหัสผ่านไม่ถูกต้อง" };
  } catch(e) { return { success:false, message:e.message }; }
}

// ── MAILBOX: Senior sends ─────────────────────────────────────
function seniorSendMail(seniorId, seniorPass, messageContent, scheduledRelease) {
  try {
    const senior = _verifySenior(seniorId, seniorPass);
    if (!senior) return { success:false, message:"ยืนยันตัวตนไม่สำเร็จ" };
    if (!messageContent?.trim()) return { success:false, message:"กรุณาใส่ข้อความ" };

    const s   = sh(SH_MAILBOX);
    if (s.getLastRow()===0) s.appendRow(["mail_id","tarot","message_content","created_at","scheduled_release"]);

    const now     = new Date();
    const release = scheduledRelease ? new Date(scheduledRelease) : now;
    const mailId  = "MAIL_"+now.getTime();

    const { head, rows } = sheetRows(SH_MAILBOX);
    const ti = head.indexOf("tarot");
    const cardNum = rows.filter(r=>r[ti]===senior.tarot).length + 1;

    s.appendRow([mailId, senior.tarot, messageContent.trim(), now.toISOString(), release.toISOString()]);
    return { success:true, mailId, cardNumber:cardNum };
  } catch(e) { return { success:false, message:e.message }; }
}

// ── MAILBOX: Get for junior ───────────────────────────────────
function juniorGetMailbox(juniorId, juniorPass) {
  try {
    const junior = _verifyJunior(juniorId, juniorPass);
    if (!junior) return { success:false, message:"ยืนยันตัวตนไม่สำเร็จ" };

    const now = Date.now();
    const { head, rows } = sheetRows(SH_MAILBOX);
    if (!head.length) return { success:true, tarot:junior.tarot, letters:[], serverTime:now };

    const idx = {
      mail_id:           head.indexOf("mail_id"),
      tarot:             head.indexOf("tarot"),
      message_content:   head.indexOf("message_content"),
      created_at:        head.indexOf("created_at"),
      scheduled_release: head.indexOf("scheduled_release"),
    };

    let cn=0;
    const letters=[];
    rows.filter(r=>r[idx.tarot]===junior.tarot)
      .sort((a,b)=>new Date(a[idx.created_at])-new Date(b[idx.created_at]))
      .forEach(r=>{
        cn++;
        const rel = new Date(r[idx.scheduled_release]).getTime();
        letters.push(rel>now
          ? { mail_id:r[idx.mail_id], locked:true, release_at:r[idx.scheduled_release], card_number:cn }
          : { mail_id:r[idx.mail_id], locked:false, message:r[idx.message_content],
              card_number:cn, created_at:r[idx.created_at] });
      });

    return { success:true, tarot:junior.tarot, letters, serverTime:now };
  } catch(e) { return { success:false, message:e.message }; }
}

// ── MAILBOX: Score event when junior opens ────────────────────
function juniorOpenLetter(juniorId, juniorPass) {
  try {
    const junior = _verifyJunior(juniorId, juniorPass);
    if (!junior) return { success:false };
    _addScore(junior.tarot, 5);  // 5 pts per letter opened
    return { success:true };
  } catch(e) { return { success:false }; }
}

// ── MAILBOX: Senior views sent ────────────────────────────────
function seniorGetMailbox(seniorId, seniorPass) {
  try {
    const senior = _verifySenior(seniorId, seniorPass);
    if (!senior) return { success:false };
    const now = Date.now();
    const { head, rows } = sheetRows(SH_MAILBOX);
    if (!head.length) return { success:true, letters:[], juniorName:"", tarot:senior.tarot };

    const idx = {
      mail_id:head.indexOf("mail_id"), tarot:head.indexOf("tarot"),
      message_content:head.indexOf("message_content"), created_at:head.indexOf("created_at"),
      scheduled_release:head.indexOf("scheduled_release"),
    };
    const { head:jh, rows:jr } = sheetRows(SH_JUNIORS);
    const jRow = jr.find(r=>rowToObj(jh,r).tarot===senior.tarot);
    const juniorName = jRow ? withPrefix(rowToObj(jh,jRow).name,"junior") : "ยังไม่ได้รับน้อง";

    let cn=0;
    const letters = rows
      .filter(r=>r[idx.tarot]===senior.tarot)
      .sort((a,b)=>new Date(a[idx.created_at])-new Date(b[idx.created_at]))
      .map(r=>({ mail_id:r[idx.mail_id], message:r[idx.message_content],
        created_at:r[idx.created_at], scheduled_release:r[idx.scheduled_release],
        card_number:++cn, released:new Date(r[idx.scheduled_release]).getTime()<=now }));

    return { success:true, letters, juniorName, tarot:senior.tarot };
  } catch(e) { return { success:false, message:e.message }; }
}

// ── MAILBOX: Delete scheduled (not yet released) ──────────────
function seniorDeleteMail(seniorId, seniorPass, mailId) {
  try {
    const senior = _verifySenior(seniorId, seniorPass);
    if (!senior) return { success:false };
    const s=sh(SH_MAILBOX), data=s.getDataRange().getValues();
    const mi=data[0].indexOf("mail_id"), ti=data[0].indexOf("tarot"), ri=data[0].indexOf("scheduled_release");
    const now=Date.now();
    for (let i=1;i<data.length;i++) {
      if (data[i][mi]===mailId && data[i][ti]===senior.tarot) {
        if (new Date(data[i][ri]).getTime()<=now) return { success:false, message:"ลบไม่ได้ ส่งแล้ว" };
        s.deleteRow(i+1); return { success:true };
      }
    }
    return { success:false, message:"ไม่พบจดหมาย" };
  } catch(e) { return { success:false, message:e.message }; }
}

// ── SCORE ─────────────────────────────────────────────────────
function _addScore(tarot, pts) {
  const k="score_"+tarot;
  setConfig(k, (parseInt(getConfig(k)||"0")+pts));
}

// Chat score is tracked via Firebase message count — computed on demand
function getChatMsgCount(tarot) {
  // Firebase chat scores are pushed from client via this GAS function
  // Called when admin loads scoreboard
  const k = "chatmsgs_"+tarot;
  return parseInt(getConfig(k)||"0");
}

// Client calls this to record chat activity for scoring
function recordChatMessage(userId, userPass, chatType) {
  try {
    let tarot=null;
    const j=_verifyJunior(userId,userPass); if(j) tarot=j.tarot;
    else { const s=_verifySenior(userId,userPass); if(s) tarot=s.tarot; }
    if (!tarot||chatType==="admin") return {success:true}; // admin chat not scored

    // Increment chat msg count for this tarot
    const k="chatmsgs_"+tarot;
    const cur=parseInt(getConfig(k)||"0");
    setConfig(k, cur+1);
    return {success:true};
  } catch(e) { return {success:false}; }
}

function getScoreBoard() {
  try {
    const { head:sh2, rows:sr } = sheetRows(SH_SENIORS);
    const { head:mh,  rows:mr } = sheetRows(SH_MAILBOX);
    const now=Date.now();
    const mTarot=mh.indexOf("tarot"), mRel=mh.indexOf("scheduled_release");

    const board = sr.map(r=>{
      const s=rowToObj(sh2,r);
      const tarot=s.tarot;
      const opened=mr.filter(m=>m[mTarot]===tarot&&new Date(m[mRel]).getTime()<=now).length;
      const hintScore=opened*5;  // 5 pts per sent letter
      const msgCount=getChatMsgCount(tarot);
      const chatScore=msgCount;  // 1 pt per chat message
      return { tarot, seniorName:withPrefix(s.name,"senior"), hintScore, chatScore, total:hintScore+chatScore };
    });
    board.sort((a,b)=>b.total-a.total);
    return { success:true, board };
  } catch(e) { return { success:false, board:[] }; }
}

// ── ANNOUNCEMENTS ─────────────────────────────────────────────
function adminSendAnnouncement(u, p, message, title) {
  if (String(p)!==ADMIN_PASS) return {success:false};
  // Use a unique timestamp-based key so each announcement is unique
  const ts = Date.now().toString();
  setConfig("ann_msg",   message||"");
  setConfig("ann_title", title||"ข้อความจากผู้พยากรณ์");
  setConfig("ann_ts",    ts);
  return { success:true, ts };
}

// Client sends the ts of last seen announcement; server returns new one if exists
// Return current ann ts so client can pre-mark as seen on first login
function getLatestAnnTs() {
  var tsRaw = getConfig("ann_ts");
  return { ts: tsRaw ? String(Math.round(Number(tsRaw))) : '0' };
}

function getAnnouncement(seenTs) {
  try {
    var tsRaw = getConfig("ann_ts");
    var msg = getConfig("ann_msg") || "";
    if (!tsRaw || !msg) return { hasNew: false };
    var ts = String(Math.round(Number(tsRaw)));
    var seen = String(Math.round(Number(seenTs || "0")));
    if (ts === seen || ts === "0") return { hasNew: false };
    return { hasNew: true, message: msg,
      title: getConfig("ann_title") || "ข้อความจากผู้พยากรณ์", ts: ts };
  } catch(e) { return { hasNew: false }; }
}

// ── ADMIN: Matrix ─────────────────────────────────────────────
function getAdminMatrix() {
  try {
    const { head:sh2, rows:sr } = sheetRows(SH_SENIORS);
    const { head:jh,  rows:jr } = sheetRows(SH_JUNIORS);
    const { head:mh,  rows:mr } = sheetRows(SH_MAILBOX);
    const now=Date.now();
    const mTi=mh.indexOf("tarot"), mRi=mh.indexOf("scheduled_release");
    const jiId=jh.indexOf("id"), jiName=jh.indexOf("name"), jiTarot=jh.indexOf("tarot");

    // Build senior lookup by tarot
    const seniorByTarot={};
    sr.forEach(r=>{const s=rowToObj(sh2,r);seniorByTarot[s.tarot]=s;});

    // Junior-centric: one row per junior (handles multiple juniors per tarot)
    const pairs=jr.map(r=>{
      const j=rowToObj(jh,r);
      const s=seniorByTarot[j.tarot]||{};
      const letters=mr.filter(m=>m[mTi]===j.tarot);
      const released=letters.filter(m=>new Date(m[mRi]).getTime()<=now).length;
      const msgCount=getChatMsgCount(j.tarot);
      const jId=String(j.id||'').trim();
      return {
        seniorName:withPrefix(s.name||'—',"senior"),
        juniorName:withPrefix(j.name||'—',"junior"),
        juniorId:jId,
        tarot:j.tarot, totalLetters:letters.length,
        releasedLetters:released, chatMessages:msgCount,
      };
    });
    return { success:true, pairs, startDate:getConfig("START_DATE"), serverTime:now };
  } catch(e) { return { success:false, message:e.message }; }
}

function adminSetStartDate(u, p, d) {
  if (String(p)!==ADMIN_PASS) return {success:false};
  setConfig("START_DATE", d); return {success:true};
}

// ── Senior: check if junior guessed correctly ────────────────
function checkGuessNotify(tarot) {
  try {
    var key = 'guess_notify_' + String(tarot).replace(/[^a-zA-Z0-9_]/g,'_');
    var raw = getConfig(key);
    if (!raw) return null;
    try { return JSON.parse(String(raw)); } catch(e) { return null; }
  } catch(e) { return null; }
}

// ── Poll: mailbox check + announcement ───────────────────────
function pollUpdates(userId, userPass, lastMailCount, seenAnnTs) {
  try {
    let tarot=null;
    const j=_verifyJunior(userId,userPass); if(j) tarot=j.tarot;
    else { const s=_verifySenior(userId,userPass); if(s) tarot=s.tarot; }

    const now=Date.now(); let avail=0;
    if (tarot) {
      const {head,rows}=sheetRows(SH_MAILBOX);
      if (head.length) {
        const ti=head.indexOf("tarot"),ri=head.indexOf("scheduled_release");
        avail=rows.filter(r=>r[ti]===tarot&&new Date(r[ri]).getTime()<=now).length;
      }
    }
    const ann=getAnnouncement(seenAnnTs);
    var guessNotify = null;
    if (tarot) {
      var gn = checkGuessNotify(tarot);
      if (gn) guessNotify = gn;
    }
    return { success:true, availableCount:avail,
      hasNewMail: avail>(lastMailCount||0),
      announcement: ann.hasNew?ann:null,
      guessNotify: guessNotify,
      serverTime:now };
  } catch(e) { return { success:false }; }
}

// ── Helpers ───────────────────────────────────────────────────
function _verifyJunior(id, pass) {
  const { head, rows } = sheetRows(SH_JUNIORS);
  for (const r of rows) { const o=rowToObj(head,r); if(String(o.id)===String(id)&&String(o.password)===String(pass)) return o; }
  return null;
}
function _verifySenior(id, pass) {
  const { head, rows } = sheetRows(SH_SENIORS);
  for (const r of rows) { const o=rowToObj(head,r); if(String(o.id)===String(id)&&String(o.password)===String(pass)) return o; }
  return null;
}
function testLogin() {
  var result = handleLogin("admin", "tarotadmin6202");
  Logger.log(JSON.stringify(result));
}

// ── GUESS SYSTEM ─────────────────────────────────────────
// Juniors_Data needs columns: id|password|name|tarot|guess_ts|guessed_at|hearts
// hearts: remaining guesses (default 3). guess_ts: last wrong guess timestamp.

function juniorGuess(juniorId, juniorPass, guessName) {
  try {
    var junior = _verifyJunior(juniorId, juniorPass);
    if (!junior) return { success: false, message: 'ยืนยันตัวตนไม่สำเร็จ' };

    var s = ss().getSheetByName(SH_JUNIORS);
    var data = s.getDataRange().getValues();
    var head = data[0];
    var idIdx    = head.indexOf('id');
    var gTsIdx   = head.indexOf('guess_ts');
    var gAtIdx   = head.indexOf('guessed_at');
    var heartsIdx = head.indexOf('hearts');

    // Auto-add columns if missing
    if (gTsIdx < 0)    { gTsIdx   = head.length; s.getRange(1, gTsIdx   + 1).setValue('guess_ts');   data = s.getDataRange().getValues(); head = data[0]; }
    if (gAtIdx < 0)    { gAtIdx   = head.length; s.getRange(1, gAtIdx   + 1).setValue('guessed_at'); data = s.getDataRange().getValues(); head = data[0]; }
    if (heartsIdx < 0) { heartsIdx = head.length; s.getRange(1, heartsIdx + 1).setValue('hearts');    data = s.getDataRange().getValues(); head = data[0]; }

    var now = Date.now();
    var rowIdx = -1;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][idIdx]) === String(juniorId)) { rowIdx = i; break; }
    }
    if (rowIdx < 0) return { success: false, message: 'ไม่พบข้อมูล' };

    var row = data[rowIdx];
    var guessTs   = row[gTsIdx]  ? Number(row[gTsIdx])  : 0;
    var guessedAt = row[gAtIdx]  ? String(row[gAtIdx])  : '';
    var hearts    = row[heartsIdx] !== '' && row[heartsIdx] !== undefined
                      ? Number(row[heartsIdx]) : 3; // default 3

    // Already guessed correctly?
    if (guessedAt) return { success: true, alreadyGuessed: true, hearts: hearts };

    // Hearts depleted?
    if (hearts <= 0) return { success: true, noHearts: true, hearts: 0 };

    // 24-hour cooldown from last wrong guess
    var COOLDOWN_MS = 24 * 3600000;
    if (guessTs > 0 && (now - guessTs) < COOLDOWN_MS) {
      var waitMs = COOLDOWN_MS - (now - guessTs);
      return { success: true, cooldown: true, waitMs: Math.max(0, waitMs), hearts: hearts };
    }

    // Find senior name for this junior's tarot
    var seniorName = '', seniorRawName = '';
    var shSr = sheetRows(SH_SENIORS);
    for (var j = 0; j < shSr.rows.length; j++) {
      var sr = rowToObj(shSr.head, shSr.rows[j]);
      if (sr.tarot === junior.tarot) { seniorRawName = String(sr.name || ''); seniorName = withPrefix(sr.name, 'senior'); break; }
    }

    // Record attempt timestamp
    s.getRange(rowIdx + 1, gTsIdx + 1).setValue(now);

    // Check correctness
    var guessClean  = String(guessName || '').trim().replace(/^(พี่|น้อง)/u, '').trim().toLowerCase();
    var seniorClean = String(seniorRawName || '').trim().replace(/^(พี่|น้อง)/u, '').trim().toLowerCase();
    var isCorrect   = guessClean.length > 0 && guessClean === seniorClean;

    if (isCorrect) {
      s.getRange(rowIdx + 1, gAtIdx + 1).setValue(now);
      var rank = parseInt(getConfig('guess_rank_count') || '0') + 1;
      setConfig('guess_rank_count', rank);
      setConfig('guess_winner_' + rank, JSON.stringify({
        juniorName: withPrefix(junior.name, 'junior'),
        seniorName: seniorName, tarot: junior.tarot, ts: now
      }));
      setConfig('guess_notify_' + junior.tarot.replace(/[^a-zA-Z0-9_]/g,'_'),
        JSON.stringify({ juniorName: withPrefix(junior.name,'junior'), ts: now }));
      return { success: true, correct: true, hearts: hearts };
    }

    // Wrong — deduct 1 heart
    var newHearts = Math.max(0, hearts - 1);
    s.getRange(rowIdx + 1, heartsIdx + 1).setValue(newHearts);
    var waitMs = newHearts > 0 ? COOLDOWN_MS : 0;
    return { success: true, correct: false, hearts: newHearts, noHearts: newHearts <= 0, waitMs: waitMs };

  } catch(e) { return { success: false, message: e.message }; }
}

// Status check — returns hearts/cooldown without recording attempt
function juniorGuessStatus(juniorId, juniorPass) {
  try {
    var junior = _verifyJunior(juniorId, juniorPass);
    if (!junior) return { success: false };
    var s = ss().getSheetByName(SH_JUNIORS);
    var data = s.getDataRange().getValues();
    var head = data[0];
    var idIdx = head.indexOf('id'), gTsIdx = head.indexOf('guess_ts'),
        gAtIdx = head.indexOf('guessed_at'), heartsIdx = head.indexOf('hearts');
    var now = Date.now();
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][idIdx]) !== String(juniorId)) continue;
      var row = data[i];
      var guessTs   = row[gTsIdx]   ? Number(row[gTsIdx])   : 0;
      var guessedAt = row[gAtIdx]   ? String(row[gAtIdx])   : '';
      var hearts    = (heartsIdx >= 0 && row[heartsIdx] !== '' && row[heartsIdx] !== undefined)
                        ? Number(row[heartsIdx]) : 3;
      if (guessedAt) return { success: true, alreadyGuessed: true, hearts: hearts };
      if (hearts <= 0) return { success: true, noHearts: true, hearts: 0 };
      var COOLDOWN_MS = 24 * 3600000;
      if (guessTs > 0 && (now - guessTs) < COOLDOWN_MS) {
        return { success: true, cooldown: true, waitMs: COOLDOWN_MS - (now - guessTs), hearts: hearts };
      }
      return { success: true, hearts: hearts, canGuess: true };
    }
    return { success: true, hearts: 3, canGuess: true };
  } catch(e) { return { success: false }; }
}

function _calcNextResetMs(nowUTC) {
  var BKK_OFFSET = 7 * 3600000;
  var nowBkkDate = new Date(nowUTC + BKK_OFFSET);
  var todayBkk9UTC = Date.UTC(
    nowBkkDate.getUTCFullYear(),
    nowBkkDate.getUTCMonth(),
    nowBkkDate.getUTCDate(),
    9, 0, 0, 0
  ) - BKK_OFFSET;
  var nextResetUTC = (nowUTC < todayBkk9UTC) ? todayBkk9UTC : todayBkk9UTC + 86400000;
  return Math.max(0, nextResetUTC - nowUTC);
}

function getGuessLeaderboard() {
  try {
    var countRaw = getConfig('guess_rank_count');
    if (!countRaw) return { success: true, board: [] };
    var count = parseInt(countRaw) || 0;
    var board = [];
    for (var i = 1; i <= count; i++) {
      var raw = getConfig('guess_winner_' + i);
      if (raw) { try { board.push(JSON.parse(String(raw))); } catch(e) {} }
    }
    return { success: true, board: board };
  } catch(e) { return { success: true, board: [] }; }
}

function resetGuessSystem(adminPass) {
  var p = String(adminPass);
  if (p !== ADMIN_PASS && p !== 'TarotDeepReset101') return { success: false };
  // Clear Config entries
  var s = sh(SH_CONFIG);
  var data = s.getDataRange().getValues();
  var ki = data[0].indexOf('key');
  var toDelete = [];
  for (var i = data.length - 1; i >= 1; i--) {
    var k = String(data[i][ki]);
    if (k === 'guess_rank_count' || k.indexOf('guess_winner_') === 0) toDelete.push(i + 1);
  }
  toDelete.forEach(function(r) { s.deleteRow(r); });
  // Clear guessed_at, guess_ts, and hearts in Juniors_Data
  var js2 = ss().getSheetByName(SH_JUNIORS);
  var jd = js2.getDataRange().getValues();
  var jh = jd[0];
  var gTsIdx = jh.indexOf('guess_ts'), gAtIdx = jh.indexOf('guessed_at'), heartsIdx = jh.indexOf('hearts');
  for (var i = 1; i < jd.length; i++) {
    if (gTsIdx >= 0)    js2.getRange(i + 1, gTsIdx    + 1).setValue('');
    if (gAtIdx >= 0)    js2.getRange(i + 1, gAtIdx    + 1).setValue('');
    if (heartsIdx >= 0) js2.getRange(i + 1, heartsIdx + 1).setValue(3); // restore 3 hearts
  }
  return { success: true };
}

// ── CLEAR FIREBASE CHAT ───────────────────────────────────
// (handled client-side via Firebase, this just validates password)
function validateClearPass(password) {
  return { valid: String(password) === 'TarotDeepReset101' };
}

// ── RESET CHAT SCORES ─────────────────────────────────────
function resetChatScores(adminPass) {
  if (String(adminPass) !== 'TarotDeepReset101') return { success: false };
  var s = sh(SH_CONFIG);
  var data = s.getDataRange().getValues();
  var ki = data[0].indexOf('key');
  var toDelete = [];
  for (var i = data.length - 1; i >= 1; i--) {
    var k = String(data[i][ki]);
    if (k.indexOf('chatmsgs_') === 0 || k.indexOf('score_') === 0) toDelete.push(i + 1);
  }
  toDelete.forEach(function(r) { s.deleteRow(r); });
  return { success: true };
}

// ── LOGIN COUNT ───────────────────────────────────────────
function getLoginStats() {
  try {
    var jd = sheetRows(SH_JUNIORS);
    var sd = sheetRows(SH_SENIORS);
    var totalJ = jd.rows.length, totalS = sd.rows.length;
    var total = totalJ + totalS;
    // Count logins from Config
    return { success: true, loggedIn: 0, total: total };
  } catch(e) { return { success: true, loggedIn: 0, total: 0 }; }
}

function recordLogin(userId) {
  // Disabled: no longer writing lastlogin to Config sheet (keeps sheet clean)
  return { success: true };
}

function deleteAnnouncement(adminPass) {
  if (String(adminPass) !== ADMIN_PASS) return { success: false };
  try {
    ['ann_msg','ann_title','ann_ts'].forEach(function(k){ deleteConfig(k); });
    return { success: true };
  } catch(e) { return { success: false, message: e.message }; }
}

function deleteConfig(key) {
  var s = sh(SH_CONFIG);
  var data = s.getDataRange().getValues();
  var ki = data[0].indexOf('key');
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][ki]) === key) { s.deleteRow(i + 1); break; }
  }
}

// ── TIME-DRIVEN TRIGGER: Daily scheduled mail release ──────────
// รันครั้งเดียว จาก GAS Editor เพื่อสร้าง trigger อัตโนมัติ
// Extensions → Apps Script → Run → createDailyTrigger
function createDailyTrigger() {
  // ลบ trigger เก่าที่ชื่อ releaseScheduledMail ออกก่อน (ป้องกัน duplicate)
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'releaseScheduledMail') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  // สร้าง trigger ใหม่: รันทุกวัน เวลา 09:00–10:00 น. (Bangkok = UTC+7)
  ScriptApp.newTrigger('releaseScheduledMail')
    .timeBased()
    .everyDays(1)
    .atHour(2)   // 02:00 UTC = 09:00 Bangkok
    .create();
  Logger.log('✅ Daily trigger for releaseScheduledMail created (runs ~09:00 BKK daily).');
}

// ── Scheduled mail release logic ──────────────────────────────
// ฟังก์ชันนี้จะถูกเรียกโดย trigger ทุกวัน
// ตรวจสอบว่ามีจดหมายที่ scheduled_release <= ตอนนี้ และยังไม่ได้ปลดล็อค
// (ระบบ Mailbox ปัจจุบันไม่มี "locked" flag — การ release คือการที่ scheduled_release ผ่านมาแล้ว
//  ดังนั้น trigger นี้ทำหน้าที่ log และ (optional) notify admin เมื่อมี mail ใหม่ release)
function releaseScheduledMail() {
  try {
    var now = new Date();
    var { head, rows } = sheetRows(SH_MAILBOX);
    if (!head.length) { Logger.log('Mailbox empty.'); return; }
    var ti  = head.indexOf('tarot');
    var ri  = head.indexOf('scheduled_release');
    var mi  = head.indexOf('mail_id');
    var ci  = head.indexOf('message_content');
    if (ri < 0) { Logger.log('No scheduled_release column.'); return; }

    var released = rows.filter(function(r) {
      return new Date(r[ri]).getTime() <= now.getTime();
    });
    Logger.log('releaseScheduledMail: ' + released.length + ' letter(s) available as of ' + now.toISOString());


  } catch(e) {
    Logger.log('releaseScheduledMail error: ' + e.message);
  }
}

// ════════════════════════════════════════════════════════════════
// DAILY TOPIC SYSTEM
// Sheet: Daily_Topics — columns: date (YYYY-MM-DD), topic, created_at
// ════════════════════════════════════════════════════════════════

const SH_TOPICS = "Daily_Topics";

function _ensureTopicSheet() {
  const s = sh(SH_TOPICS);
  if (s.getLastRow() === 0) s.appendRow(["date", "topic", "created_at"]);
  return s;
}

// ── ดึง topic วันนี้ (หรือวันที่ระบุ) ──────────────────────────
function getDailyTopic(dateStr) {
  try {
    const today = dateStr || Utilities.formatDate(new Date(), "Asia/Bangkok", "yyyy-MM-dd");
    const { head, rows } = sheetRows(SH_TOPICS);
    if (!head.length) return { success: true, topic: null, date: today };
    const di = head.indexOf("date"), ti = head.indexOf("topic");
    if (di < 0 || ti < 0) return { success: true, topic: null, date: today };
    // หา topic ของวันนี้ (ถ้ามีหลายแถวให้เอาแถวล่าสุด)
    let found = null;
    rows.forEach(function(r) {
      const d = _fmtDate(r[di]);
      if (d === today) found = String(r[ti]).trim();
    });
    return { success: true, topic: found, date: today };
  } catch(e) { return { success: false, message: e.message }; }
}

// ── Admin: ตั้ง/แก้ไข topic ──────────────────────────────────
function adminSetTopic(adminId, adminPass, dateStr, topicText) {
  try {
    if (!_isAdmin(adminId, adminPass)) return { success: false, message: "Unauthorized" };
    const s = _ensureTopicSheet();
    const data = s.getDataRange().getValues();
    const head = data[0];
    const di = head.indexOf("date"), ti = head.indexOf("topic"), ci = head.indexOf("created_at");
    // หาว่ามี row ของวันนั้นแล้วไหม — ถ้ามีให้ update
    for (let i = 1; i < data.length; i++) {
      if (_fmtDate(data[i][di]) === dateStr) {
        s.getRange(i + 1, ti + 1).setValue(topicText);
        s.getRange(i + 1, ci + 1).setValue(new Date().toISOString());
        return { success: true, action: "updated" };
      }
    }
    // ไม่มี → append ใหม่
    s.appendRow([dateStr, topicText, new Date().toISOString()]);
    return { success: true, action: "created" };
  } catch(e) { return { success: false, message: e.message }; }
}

// ── Admin: โหลด topics ทั้งหมด (เรียงวันที่) ─────────────────
function adminGetTopics(adminId, adminPass) {
  try {
    if (!_isAdmin(adminId, adminPass)) return { success: false, message: "Unauthorized" };
    const { head, rows } = sheetRows(SH_TOPICS);
    if (!head.length) return { success: true, topics: [] };
    const di = head.indexOf("date"), ti = head.indexOf("topic");
    const topics = rows.map(function(r) {
      return { date: _fmtDate(r[di]), topic: String(r[ti]).trim() };
    }).filter(function(t) { return t.date && t.topic; })
      .sort(function(a, b) { return a.date < b.date ? -1 : 1; });
    return { success: true, topics: topics };
  } catch(e) { return { success: false, message: e.message }; }
}

// ── Admin: ลบ topic ──────────────────────────────────────────
function adminDeleteTopic(adminId, adminPass, dateStr) {
  try {
    if (!_isAdmin(adminId, adminPass)) return { success: false, message: "Unauthorized" };
    const s = _ensureTopicSheet();
    const data = s.getDataRange().getValues();
    const di = data[0].indexOf("date");
    for (let i = data.length - 1; i >= 1; i--) {
      if (_fmtDate(data[i][di]) === dateStr) {
        s.deleteRow(i + 1);
        return { success: true };
      }
    }
    return { success: false, message: "ไม่พบ topic วันนั้น" };
  } catch(e) { return { success: false, message: e.message }; }
}

// ── Helper: ตรวจสอบ admin ──────────────────────────────────
function _isAdmin(id, pass) {
  return (String(id) === "01100101" || String(id) === "admin") && String(pass) === "tarotadmin6202";
}

// ── Helper: แปลง date value จาก Sheet เป็น yyyy-MM-dd ─────
function _fmtDate(val) {
  if (!val) return "";
  if (val instanceof Date) {
    return Utilities.formatDate(val, "Asia/Bangkok", "yyyy-MM-dd");
  }
  // อาจเป็น string แบบ "2026-06-14" อยู่แล้ว
  var s = String(val).trim();
  // ถ้าเป็น string date อื่น ลอง parse
  if (s.match(/^\d{4}-\d{2}-\d{2}$/)) return s;
  try {
    var d = new Date(s);
    if (!isNaN(d.getTime())) return Utilities.formatDate(d, "Asia/Bangkok", "yyyy-MM-dd");
  } catch(e) {}
  return s;
}

// ════════════════════════════════════════════════════════════════
// GITHUB PAGES API — doPost() รับ request จาก GitHub Pages
// ════════════════════════════════════════════════════════════════

function doPost(e) {
  var result;
  try {
    var body = JSON.parse(e.postData.contents);
    var fn   = body.fn;
    var args = body.args || [];

    var allowed = [
      'handleLogin','pollUpdates','juniorGetMailbox','juniorOpenLetter',
      'juniorGuess','juniorGuessStatus','seniorGetMailbox','seniorSendMail',
      'seniorDeleteMail','getAdminMatrix','adminSendAnnouncement',
      'deleteAnnouncement','getLatestAnnTs','getScoreBoard',
      'getGuessLeaderboard','resetGuessSystem','resetChatScores',
      'validateClearPass','adminSetStartDate','recordChatMessage',
      'getDailyTopic','adminGetTopics','adminSetTopic','adminDeleteTopic',
      'clearChatMessages'
    ];

    if (!fn || allowed.indexOf(fn) < 0) {
      result = { success: false, message: 'Function not allowed: ' + fn };
    } else {
      result = this[fn].apply(this, args);
    }
  } catch(err) {
    result = { success: false, message: err.message };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}