import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { google } from 'googleapis';
import fetch from 'node-fetch';
import * as http from 'http';

/* ---------------- ENV VARS ต้องตั้งค่าใน Railway ----------------
DISCORD_BOT_TOKEN       = token ของบอทจาก Discord Developer Portal
CHECKIN_CHANNEL_ID      = Channel ID ของห้องที่ให้โพสต์รูป check-in
ANTHROPIC_API_KEY       = API key จาก console.anthropic.com
GOOGLE_SERVICE_ACCOUNT  = เนื้อหา JSON ทั้งไฟล์ของ Service Account key (บรรทัดเดียว)
SPREADSHEET_ID          = ID จาก URL ของ Google Sheet (docs.google.com/spreadsheets/d/{ID}/edit)
SHEET_NAME              = ชื่อแท็บชีตที่จะเขียนลง (เช่น GangDuHee_W1)
CP_CHANNEL_ID           = (ไม่บังคับ) Channel ID ห้องลง CP พร้อมภาพยืนยัน
ALERT_CHANNEL_ID        = (ไม่บังคับ) Channel ID ห้องที่บอทจะแจ้งเตือนก่อนบอสเกิด
COMMANDS_CHANNEL_ID     = (ไม่บังคับ) Channel ID ห้องสำหรับพิมพ์คำสั่ง เช่น !kill
BOSS_TRACKER_SPREADSHEET_ID = (ไม่บังคับ) ID ของ Google Sheet "Boss Spawn Tracker" (คนละไฟล์กับ SPREADSHEET_ID ด้านบน)
                          ถ้าตั้งค่านี้ไว้ บอทจะอัปเดตคอลัมน์ "Last Kill Date" / "Last Kill Time (UTC+7)"
                          ในแท็บ "Boss Spawn" ของไฟล์นั้นให้อัตโนมัติทุกครั้งที่มีคนพิมพ์ !kill
                          (เฉพาะบอสแบบคูลดาวน์เท่านั้น บอสตารางตายตัวคำนวณเองอยู่แล้วไม่ต้องอัปเดต)
BOSS_TRACKER_SHEET_NAME = (ไม่บังคับ) ชื่อแท็บในไฟล์ BOSS_TRACKER_SPREADSHEET_ID ค่าเริ่มต้นคือ "Boss Spawn"
------------------------------------------------------------------ */

const {
  DISCORD_BOT_TOKEN,
  CHECKIN_CHANNEL_ID,
  ANTHROPIC_API_KEY,
  GOOGLE_SERVICE_ACCOUNT,
  SPREADSHEET_ID,
  SHEET_NAME: SHEET_NAME_ENV, // ใช้เป็นชีตต้นทาง "ครั้งแรก" เท่านั้น (คัดลอกรายชื่อสมาชิก) หลังจากนั้นระบบคำนวณชื่อชีตสัปดาห์เอง
  CP_CHANNEL_ID,
  ALERT_CHANNEL_ID,
  COMMANDS_CHANNEL_ID,
  BOSS_TRACKER_SPREADSHEET_ID,
  BOSS_TRACKER_SHEET_NAME: BOSS_TRACKER_SHEET_NAME_ENV,
} = process.env;
let SHEET_NAME = SHEET_NAME_ENV || null; // จะถูกอัปเดตอัตโนมัติทุกสัปดาห์โดย ensureActiveSheet()
const BOSS_TRACKER_SHEET_NAME = BOSS_TRACKER_SHEET_NAME_ENV || 'Boss Spawn';

// บันทึกการ !kill ล่าสุดไว้ในหน่วยความจำ (ไม่ผูกกับชีต) เพื่อให้ Dashboard ขึ้นป้าย "เพิ่งถูกฆ่า" ได้ทันที
// โดยไม่ต้องรอให้เวลานับถอยหลังหมดเอง — เก็บไว้ 10 นาทีตามเวลาจริงที่พิมพ์คำสั่ง (recordedAt) แล้วทิ้งอัตโนมัติ
const RECENT_KILL_WINDOW_MS = 10 * 60000;
const recentKills = [];
function recordRecentKill(bossName, killDate) {
  recentKills.push({ boss: bossName, killedAt: killDate.getTime(), recordedAt: Date.now() });
  const cutoff = Date.now() - RECENT_KILL_WINDOW_MS;
  while (recentKills.length && recentKills[0].recordedAt < cutoff) recentKills.shift();
}

if (!DISCORD_BOT_TOKEN || !CHECKIN_CHANNEL_ID || !ANTHROPIC_API_KEY || !GOOGLE_SERVICE_ACCOUNT || !SPREADSHEET_ID) {
  console.error('❌ ตั้งค่า Environment Variables ไม่ครบ');
  process.exit(1);
}
const ALERT_MINUTES = 5;

/* ---------------- ตารางคะแนนต่อบอส (จากกติกากิลด์ HEAVEN) ----------------
   ทุกคนที่เข้าร่วมบอสตัวเดียวกัน ได้ค่าเท่ากันตามนี้ ปรับแก้ตัวเลขได้ตามจริง
   ถ้าเจอชื่อบอสที่ไม่อยู่ในลิสต์นี้ บอทจะแจ้งเตือนแทนการเดา */
const BOSS_POINTS = {
  // บอสทั่วไป = 1 คะแนน
  'venatus': 1, 'viorent': 1, 'ego': 1, 'clemantis': 1, 'livera': 1, 'araneo': 1,
  'undomiel': 1, 'saphirus': 1, 'neutro': 1, 'lady dalia': 1, 'general aqueles': 1,
  'general aquleus': 1, 'thymele': 1, 'amentis': 1, 'baron braudmore': 1, 'baron': 1, 'milavy': 1,
  'millavy': 1, 'wannitas': 1, 'wannitus': 1, 'metus': 1, 'duplican': 1, 'shuliar': 1,
  'ringor': 1, 'roderick': 1, 'gareth': 1, 'tiyore': 1, 'titore': 1, 'larba': 1,
  // Boss Lv.100 = 1.5 คะแนน
  'catena': 1.5, 'orgue': 1.5, 'secreta': 1.5, 'ordo': 1.5, 'asta': 1.5, 'supore': 1.5,
  // Auraq Boss = 3 คะแนน (แยกจาก Lv.100 ทั่วไป)
  'auraq': 3,
  // Boss Lv.120 = 3 คะแนน
  'chiflock': 3, 'chaiflock': 3, 'benji': 3,
  // Boss Lv.135+ = 10 คะแนน
  'libitina': 10, 'rakejeth': 10, 'lacases': 10, 'rakajeth': 10, 'icarutier': 10, 'icaruthia': 10,
  'motti': 10, 'mortti': 10, 'kamalia': 10, 'nevaeh': 10, 'tumer': 10, 'tumier': 10, 'lucus': 10,
  // Guild Dungeon = 5 คะแนน
  'gd1': 5, 'gd2': 5, 'gd3': 5,
};

function getBossPoints(name) {
  const key = name.trim().toLowerCase();
  if (BOSS_POINTS[key]) return BOSS_POINTS[key];
  const found = Object.keys(BOSS_POINTS).find(k => key.includes(k) || k.includes(key));
  return found ? BOSS_POINTS[found] : null;
}

// ระดับเลเวลของบอสแต่ละตัว ใช้สร้างหัวคอลัมน์ "Lv.XX ชื่อบอส" ให้อัตโนมัติตอนแทรกตารางใหม่
const NAME_LEVEL = {
  venatus:60, viorent:65, ego:70, clemantis:70, livera:75, araneo:75, undomiel:80,
  saphirus:80, neutro:80, 'lady dalia':85, 'general aquleus':85, 'general aqueles':85,
  thymele:85, amentis:88, baron:88, milavy:90, millavy:90, wannitas:93,
  metus:93, duplican:93, shuliar:95, ringor:95, roderick:95, gareth:98, titore:98,
  larba:98, catena:100, auraq:100, secreta:100, ordo:100, asta:100, supore:100,
  chaiflock:120, benji:120, libitina:130, rakajeth:130, icaruthia:135,
  motti:135, kamalia:135, tumier:140, nevaeh:140,
  lucus:145,
};
const MANDATORY_BOSSES = new Set(['motti','icaruthia','nevaeh','lucus']);
// สะกดแบบอื่นของชื่อเดียวกัน (ที่ต่างกันเกินกว่าระบบเดาใกล้เคียงจะจับได้) -> ชื่อมาตรฐาน (อิงตาม RaidScout)
const ENGLISH_ALIASES = {
  mortti: 'motti', icarutier: 'icaruthia', tumer: 'tumier',
  lacases: 'rakajeth', rakejeth: 'rakajeth', chiflock: 'chaiflock',
  'baron braudmore': 'baron',
};

function getBossLevel(name) {
  const key = name.trim().toLowerCase();
  if (NAME_LEVEL[key] !== undefined) return NAME_LEVEL[key];
  const found = Object.keys(NAME_LEVEL).find(k => key.includes(k) || k.includes(key));
  return found ? NAME_LEVEL[found] : 0;
}

/* ---------------- Google Sheets auth ---------------- */
const serviceAccount = JSON.parse(GOOGLE_SERVICE_ACCOUNT);
const auth = new google.auth.GoogleAuth({
  credentials: serviceAccount,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// เทียบความใกล้เคียงของชื่อ (จำนวนตัวอักษรที่ต้องแก้ให้เหมือนกัน ยิ่งน้อยยิ่งใกล้)
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

// เช็คประเภทไฟล์จากเนื้อหาภาพจริง (ไม่เชื่อ label ที่ Discord ส่งมา เพราะบางทีบอกผิด)
function sniffImageType(buffer) {
  const b = Buffer.from(buffer);
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 6 && b.toString('ascii', 0, 3) === 'GIF') return 'image/gif';
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// ชื่อบอสภาษาไทย -> ชื่ออังกฤษมาตรฐาน (lowercase) ใช้ตอนพิมพ์เป็นไทยล้วนหรือสะกดคนละแบบ
const THAI_BOSS_NAMES = {
  'เอโก้': 'ego', 'เวนาตัส': 'venatus', 'เวนาดัส': 'venatus', 'วิโอเลนท์': 'viorent',
  'คลาแมนทีส': 'clemantis', 'คลาแมนทัส': 'clemantis', 'ริเวอร์ร่า': 'livera',
  'อาราเนโอ': 'araneo', 'อันโดมิเอล': 'undomiel', 'ซาฟิรัส': 'saphirus', 'ชาฟิรัส': 'saphirus',
  'นิวโทร': 'neutro', 'เลดี้ดาเลีย': 'lady dalia', 'นายพลอะคูเลส': 'general aquleus',
  'ไธเมล': 'thymele', 'อาเมนติส': 'amentis', 'อาเมนดิส': 'amentis',
  'บารอนบราวด์มอร์': 'baron', 'มิลลาวี': 'milavy', 'วานิตัส': 'wannitas',
  'วานิดัส': 'wannitas', 'เมทูส': 'metus', 'ดูพลิแคน': 'duplican', 'ชูเลียร์': 'shuliar',
  'ริงกอร์': 'ringor', 'โรเดอริก': 'roderick', 'กาเลส': 'gareth', 'ธีธอร์': 'titore',
  'ลาร์บา': 'larba', 'คาเธน่า': 'catena', 'ออร์ค': 'auraq', 'ออรัค': 'auraq',
  'เซเครต้า': 'secreta', 'ออร์โด': 'ordo', 'แอสต้า': 'asta', 'ซูโพร์': 'supore',
  'ไชฟล็อก': 'chaiflock', 'เบนจี้': 'benji', 'ลิบิธีน่า': 'libitina', 'ลาคาเซส': 'rakajeth',
  'อิคารูเธียร์': 'icaruthia', 'อิคารูเทีย': 'icaruthia', 'มอร์ตี้': 'motti',
  'คามาเลีย': 'kamalia', 'ทูเมียร์': 'tumier', 'เนว่า': 'nevaeh', 'ลูคัส': 'lucus',
};
const CANON_BOSS_NAMES = [...new Set([...Object.keys(NAME_LEVEL), 'gd1', 'gd2', 'gd3'])];

// รู้จักชื่อบอสได้ทั้งไทย/อังกฤษ/ผสมสองภาษา และเดาให้ถ้าสะกดเพี้ยนเล็กน้อย
function resolveBossName(raw) {
  const candidates = [];
  const paren = raw.match(/\(([A-Za-z0-9\s]+)\)/);
  if (paren) candidates.push(paren[1].trim());
  candidates.push(raw.trim());

  for (const cand of candidates) {
    const low = cand.toLowerCase();
    const aliasHit = Object.keys(ENGLISH_ALIASES).find(a => low === a || low.includes(a) || a.includes(low));
    if (aliasHit) return ENGLISH_ALIASES[aliasHit];
    const engHit = CANON_BOSS_NAMES.find(c => low === c || low.includes(c) || c.includes(low));
    if (engHit) return engHit;
    const thaiHit = Object.keys(THAI_BOSS_NAMES).find(t => cand.includes(t) || t.includes(cand));
    if (thaiHit) return THAI_BOSS_NAMES[thaiHit];
  }

  // ไม่เจอแบบตรง/มีคำซ้อนกัน → ลองจับคู่แบบใกล้เคียง (พิมพ์เพี้ยน) ทั้งไทยและอังกฤษ
  const plain = (raw.replace(/\([^)]*\)/g, '').trim() || raw.trim());
  const plainLower = plain.toLowerCase();
  let best = null, bestDist = Infinity;
  for (const c of CANON_BOSS_NAMES) {
    const d = levenshtein(plainLower, c);
    if (d < bestDist) { bestDist = d; best = c; }
  }
  for (const a of Object.keys(ENGLISH_ALIASES)) {
    const d = levenshtein(plainLower, a);
    if (d < bestDist) { bestDist = d; best = ENGLISH_ALIASES[a]; }
  }
  for (const [thaiName, eng] of Object.entries(THAI_BOSS_NAMES)) {
    const d = levenshtein(plain, thaiName);
    if (d < bestDist) { bestDist = d; best = eng; }
  }
  const threshold = plainLower.length <= 5 ? 1 : (plainLower.length <= 8 ? 2 : 3);
  return (best && bestDist <= threshold) ? best : null;
}

/* ---------------- ขึ้นสัปดาห์ใหม่อัตโนมัติ ---------------- */
// บอสตารางตายตัว (ไม่มีคูลดาวน์ ไม่ใช้ !kill) — วัน/เวลาเดิมทุกสัปดาห์ ใช้สร้างคอลัมน์ล่วงหน้าตอนขึ้นชีตใหม่
const FIXED_SCHEDULE = {
  motti: [['Wed', '18:00'], ['Sat', '18:00']],
  icaruthia: [['Tue', '20:00'], ['Fri', '20:00']],
  nevaeh: [['Sun', '21:00']],
  lucus: [['Sat', '21:00']],
  clemantis: [['Mon', '10:30'], ['Thu', '18:00']],
  saphirus: [['Sun', '16:00'], ['Tue', '10:30']],
  neutro: [['Tue', '18:00'], ['Thu', '10:30']],
  thymele: [['Mon', '18:00'], ['Wed', '10:30']],
  milavy: [['Sat', '14:00']],
  ringor: [['Sat', '16:00']],
  roderick: [['Fri', '18:00']],
  auraq: [['Fri', '21:00'], ['Wed', '20:00']],
  chaiflock: [['Sun', '14:00']],
  benji: [['Sun', '20:00']],
  libitina: [['Mon', '20:00'], ['Sat', '20:00']],
  rakajeth: [['Tue', '21:00'], ['Sun', '18:00']],
  kamalia: [['Thu', '20:00']],
  tumier: [['Sun', '18:00']],
};
const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// หาวันจันทร์/อาทิตย์ของสัปดาห์ปัจจุบัน (จาก "วันนี้" แบบ Thai-anchored)
function getWeekBounds(now) {
  const day = now.getUTCDay(); // 0=อาทิตย์
  const diffToMonday = day === 0 ? -6 : 1 - day;
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + diffToMonday));
  const sunday = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 6));
  return { monday, sunday };
}
function weekSheetName(monday, sunday) {
  return `Week_${monday.getUTCDate()}${MONTH_ABBR[monday.getUTCMonth()]}-${sunday.getUTCDate()}${MONTH_ABBR[sunday.getUTCMonth()]}`;
}
// สร้างรายการคอลัมน์บอสตารางตายตัวทั้งหมดของสัปดาห์ที่ขึ้นต้นด้วย monday ที่กำหนด
function buildWeekOccurrences(monday) {
  const occ = [];
  for (const [boss, slots] of Object.entries(FIXED_SCHEDULE)) {
    for (const [day, time] of slots) {
      const dayOffset = (DAY_INDEX[day] - 1 + 7) % 7; // จันทร์ = offset 0
      const [h, m] = time.split(':').map(Number);
      const dt = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + dayOffset, h, m));
      occ.push({ boss, dt });
    }
  }
  occ.sort((a, b) => a.dt.getTime() - b.dt.getTime());
  return occ;
}

// ถ้าพิมพ์เวลากำกับมาด้วย (เช่น "Clemantis 10:30") ให้ดึงออกมาใช้จับคู่คอลัมน์ที่ถูกต้อง
function parseTypedTime(raw) {
  const m = raw.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!m) return null;
  const h = parseInt(m[1], 10), mi = parseInt(m[2], 10);
  if (h > 23 || mi > 59) return null;
  return { minutes: h * 60 + mi, raw: m[0] };
}

// เวลาปัจจุบันตามเวลาไทย (UTC+7) เป็นนาทีนับจากเที่ยงคืน — ใช้ตอนไม่ได้พิมพ์เวลากำกับมา
function thaiNowMinutes() {
  const now = new Date();
  const thai = new Date(now.getTime() + (7 * 60 - now.getTimezoneOffset()) * 60000);
  const [hh, mm] = thai.toISOString().slice(11, 16).split(':').map(Number);
  return hh * 60 + mm;
}

// ถ้าพิมพ์วันที่กำกับมาด้วย (เช่น "Clemantis 2026-08-31" หรือ "Clemantis 31/08") ให้ดึงออกมาใช้แทน "วันนี้"
function parseTypedDate(raw) {
  const iso = raw.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return { date: iso[0], raw: iso[0] };
  const dm = raw.match(/\b(\d{1,2})\/(\d{1,2})\b/);
  if (dm) {
    const dd = dm[1].padStart(2, '0'), mm = dm[2].padStart(2, '0');
    const year = new Date().getFullYear(); // ปีปัจจุบัน — ถ้าข้ามปีให้พิมพ์แบบ YYYY-MM-DD เต็มแทน
    return { date: `${year}-${mm}-${dd}`, raw: dm[0] };
  }
  return null;
}

function colToLetter(col) {
  let letter = '';
  col += 1;
  while (col > 0) {
    const rem = (col - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    col = Math.floor((col - 1) / 26);
  }
  return letter;
}

function thaiDateToday() {
  const now = new Date();
  const thai = new Date(now.getTime() + (7 * 60 - now.getTimezoneOffset()) * 60000);
  return thai.toISOString().slice(0, 10); // YYYY-MM-DD
}

let cachedSheetId = null;
async function getSheetGid() {
  if (cachedSheetId !== null) return cachedSheetId;
  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const found = meta.data.sheets.find(s => s.properties.title === SHEET_NAME);
  if (!found) throw new Error(`ไม่พบแท็บชื่อ "${SHEET_NAME}" ในสเปรดชีต`);
  cachedSheetId = found.properties.sheetId;
  return cachedSheetId;
}

// สร้างชีตสัปดาห์ใหม่: หัวตาราง + คอลัมน์บอสตารางตายตัวของสัปดาห์นั้น + คัดลอกรายชื่อสมาชิกจากสัปดาห์ก่อนหน้า (Score/CP เริ่มใหม่)
async function createWeekSheet(name, monday, sunday, meta) {
  // หาชีตต้นทางสำหรับคัดลอกรายชื่อสมาชิก: สัปดาห์ก่อนหน้าก่อน ถ้าไม่มีค่อย fallback ไปชีตที่ตั้งไว้ตอนแรกสุด (SHEET_NAME_ENV)
  const prevMonday = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() - 7));
  const prevSunday = new Date(Date.UTC(prevMonday.getUTCFullYear(), prevMonday.getUTCMonth(), prevMonday.getUTCDate() + 6));
  const prevName = weekSheetName(prevMonday, prevSunday);
  let sourceName = null;
  if (meta.data.sheets.some(s => s.properties.title === prevName)) sourceName = prevName;
  else if (SHEET_NAME_ENV && meta.data.sheets.some(s => s.properties.title === SHEET_NAME_ENV)) sourceName = SHEET_NAME_ENV;

  let memberNames = [];
  if (sourceName) {
    try {
      const srcRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${sourceName}!A1:ZZ2000` });
      const srcRows = srcRes.data.values || [];
      let srcLabelRow = -1, srcMemberCol = -1;
      for (let r = 0; r < Math.min(srcRows.length, 10); r++) {
        const idx = (srcRows[r] || []).findIndex(c => (c || '').trim().toLowerCase() === 'member');
        if (idx !== -1) { srcLabelRow = r; srcMemberCol = idx; break; }
      }
      if (srcLabelRow !== -1) {
        for (let r = srcLabelRow + 2; r < srcRows.length; r++) {
          const nm = (srcRows[r][srcMemberCol] || '').trim();
          if (nm) memberNames.push(nm);
        }
      }
    } catch (e) { console.error('อ่านรายชื่อจากชีตก่อนหน้าไม่สำเร็จ', e); }
  }

  const occurrences = buildWeekOccurrences(monday);
  const FIRST_BOSS_COL0 = 8; // 0-indexed: A..H = 135(1),135(2),Nevaeh,Lucas,No.,Member,Score,CP
  const lastBossCol0 = FIRST_BOSS_COL0 + occurrences.length - 1;
  const colOf = (bossKey) => occurrences.map((o, i) => ({ o, i })).filter(x => x.o.boss === bossKey).map(x => FIRST_BOSS_COL0 + x.i);
  const mottiIcarCols0 = [...colOf('motti'), ...colOf('icaruthia')];
  const nevaehCols0 = colOf('nevaeh');
  const lucusCols0 = colOf('lucus');

  // 1) สร้างแท็บใหม่
  const addRes = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ addSheet: { properties: { title: name } } }] },
  });
  const newSheetId = addRes.data.replies[0].addSheet.properties.sheetId;

  // 2) เตรียมค่าทุกแถว (หัวตาราง + ข้อมูลสมาชิก)
  const headerFixed = ['135 (1)', '135 (2)', 'Nevaeh', 'Lucas', 'No.', 'Member', 'Score', 'CP'];
  const bossHeaders = occurrences.map(o => `Lv.${getBossLevel(o.boss)} ${o.boss.charAt(0).toUpperCase() + o.boss.slice(1)}`);
  const bossDates = occurrences.map(o => fmtSheetDT(o.dt));

  const values = [];
  values.push([`HEAVEN — Weekly Attendance (${name.replace('Week_', '')})`]);
  values.push([]);
  values.push([...headerFixed, ...bossHeaders]);
  values.push(['', '', '', '', '', '', '', '', ...bossDates]);
  memberNames.forEach((nm, i) => {
    const r = 5 + i; // เลขแถวจริง (1-indexed)
    const scoreFormula = `=SUM(${colToLetter(FIRST_BOSS_COL0)}${r}:${colToLetter(lastBossCol0)}${r})`;
    const f135_1 = mottiIcarCols0.length ? `=COUNT(${mottiIcarCols0.map(c => colToLetter(c) + r).join(',')})>=1` : 'FALSE';
    const f135_2 = mottiIcarCols0.length ? `=COUNT(${mottiIcarCols0.map(c => colToLetter(c) + r).join(',')})>=2` : 'FALSE';
    const fNevaeh = nevaehCols0.length ? `=COUNT(${colToLetter(nevaehCols0[0])}${r})>=1` : 'FALSE';
    const fLucas = lucusCols0.length ? `=COUNT(${colToLetter(lucusCols0[0])}${r})>=1` : 'FALSE';
    values.push([f135_1, f135_2, fNevaeh, fLucas, i + 1, nm, scoreFormula, '']);
  });

  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${name}!A1`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });

  // 3) จัดสีหัวตาราง (ทอง = ทั่วไป, แดง = บอสบังคับ)
  const goldBg = { red: 0.914, green: 0.769, blue: 0.416 };
  const redBg = { red: 0.698, green: 0.227, blue: 0.290 };
  const fmtRequests = [
    { repeatCell: {
        range: { sheetId: newSheetId, startRowIndex: 2, endRowIndex: 4, startColumnIndex: 0, endColumnIndex: FIRST_BOSS_COL0 },
        cell: { userEnteredFormat: { backgroundColor: goldBg } }, fields: 'userEnteredFormat.backgroundColor',
    } },
  ];
  occurrences.forEach((o, i) => {
    const col = FIRST_BOSS_COL0 + i;
    const mandatory = MANDATORY_BOSSES.has(o.boss);
    fmtRequests.push({ repeatCell: {
      range: { sheetId: newSheetId, startRowIndex: 2, endRowIndex: 4, startColumnIndex: col, endColumnIndex: col + 1 },
      cell: { userEnteredFormat: { backgroundColor: mandatory ? redBg : goldBg } }, fields: 'userEnteredFormat.backgroundColor',
    } });
  });
  await sheets.spreadsheets.batchUpdate({ spreadsheetId: SPREADSHEET_ID, requestBody: { requests: fmtRequests } });

  console.log(`📅 สร้างชีตสัปดาห์ใหม่ "${name}" แล้ว (คัดลอกสมาชิก ${memberNames.length} คนจาก "${sourceName || '-'}", บอสตารางตายตัว ${occurrences.length} คอลัมน์)`);
}

let activeSheetCache = null; // { name }
// เรียกก่อนทุกครั้งที่จะอ่าน/เขียนชีต — คำนวณชื่อชีตสัปดาห์ปัจจุบัน สร้างใหม่อัตโนมัติถ้ายังไม่มี
async function ensureActiveSheet() {
  const now = thaiNowAnchored();
  const { monday, sunday } = getWeekBounds(now);
  const name = weekSheetName(monday, sunday);

  if (activeSheetCache && activeSheetCache.name === name) {
    SHEET_NAME = name;
    return name;
  }

  const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const exists = meta.data.sheets.some(s => s.properties.title === name);
  if (!exists) {
    await createWeekSheet(name, monday, sunday, meta);
  }
  cachedSheetId = null; // เปลี่ยนชีตแล้ว ต้องหา gid ใหม่รอบหน้า
  activeSheetCache = { name };
  SHEET_NAME = name;
  return name;
}

function minutesDiff(dtTextA, dtTextB) {
  const parse = (s) => {
    const m = String(s).trim().match(/^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2})/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])).getTime();
  };
  const a = parse(dtTextA), b = parse(dtTextB);
  if (a === null || b === null) return Infinity;
  return Math.abs(a - b) / 60000;
}

// อ่านภาพตารางบอสประจำวัน (จากทีม backend) แล้วแทรกคอลัมน์ใหม่เข้าตำแหน่งที่ถูกต้องตามวันเวลา
async function handleScheduleImage(message, image) {
  await message.react('⏳');
  try {
    await ensureActiveSheet();
    const imgRes = await fetch(image.url);
    const imgBuffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(imgBuffer).toString('base64');
    const mediaType = sniffImageType(imgBuffer) || image.contentType || 'image/png';

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1500,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: 'นี่คือตารางบอสเกิดของวันหนึ่งในเกม หัวข้อสีแดงด้านบนมีวันที่อยู่ในวงเล็บ 3 ตัวเลขคั่นด้วย "/" ให้อ่านตัวเลข 3 ค่านั้นตามลำดับที่เห็นในภาพเป๊ะๆ (ห้ามตีความหรือแปลงเอง แค่ลอกตัวเลขตามลำดับซ้ายไปขวา) ใส่ในฟิลด์ "date_raw" รูปแบบ "XX/XX/XXXX" ตรงตามภาพ จากนั้นอ่านทุกแถวในตาราง ดึงเฉพาะ "ชื่อบอสภาษาอังกฤษ" (ข้อความในวงเล็บ) กับค่าคอลัมน์ "Spawn Time (UTC+7)" ตัดข้อความ "(spawn #N today)" ออกจากชื่อบอสด้วย ตอบเป็น JSON เท่านั้น ไม่มีคำอธิบายอื่น รูปแบบ {"date_raw":"02/09/2026","rows":[{"boss":"Ego","time":"01:23"},{"boss":"Shuliar","time":"01:23"}]}' },
          ],
        }],
      }),
    });
    const aiData = await aiRes.json();
    if (aiData.error) {
      await message.reply(`❌ เรียก AI ไม่สำเร็จ: ${aiData.error.message || JSON.stringify(aiData.error)}`);
      await message.reactions.removeAll().catch(() => {});
      return;
    }
    const textBlock = (aiData.content || []).find(c => c.type === 'text');
    let parsed;
    try { parsed = JSON.parse(textBlock.text.replace(/```json|```/g, '').trim()); }
    catch (e) {
      await message.reply('❌ อ่านตารางไม่สำเร็จ (รูปแบบข้อมูลไม่ถูกต้อง) ลองส่งภาพที่ชัดกว่านี้');
      await message.reactions.removeAll().catch(() => {});
      return;
    }
    const { date_raw, rows } = parsed || {};
    const dm = date_raw && String(date_raw).match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!dm || !Array.isArray(rows) || !rows.length) {
      await message.reply('❌ อ่านตารางไม่สำเร็จ ไม่พบวันที่ (รูปแบบ DD/MM/YYYY) หรือรายการบอสในภาพ');
      await message.reactions.removeAll().catch(() => {});
      return;
    }
    const [, ddStr, mmStr, yyyy] = dm;
    const date = `${yyyy}-${mmStr.padStart(2, '0')}-${ddStr.padStart(2, '0')}`; // DD/MM/YYYY -> YYYY-MM-DD แปลงในโค้ดเอง ไม่พึ่ง AI

    // หาโครงสร้างหัวตาราง (แถว Member / ชื่อบอส / วันที่)
    const hdrRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A1:ZZ10` });
    const hdrRows = hdrRes.data.values || [];
    let labelRowIdx = -1, memberCol = -1;
    for (let r = 0; r < Math.min(hdrRows.length, 10); r++) {
      const idx = (hdrRows[r] || []).findIndex(c => (c || '').trim().toLowerCase() === 'member');
      if (idx !== -1) { labelRowIdx = r; memberCol = idx; break; }
    }
    if (labelRowIdx === -1) {
      await message.reply('❌ หาโครงสร้างตาราง (คอลัมน์ Member) ในชีตไม่เจอ');
      await message.reactions.removeAll().catch(() => {});
      return;
    }
    const bossRowIdx = labelRowIdx;      // แถวชื่อบอส (แถวเดียวกับ Member)
    const dateRowIdx = labelRowIdx + 1;  // แถววันที่ (ถัดจาก Member)
    const gid = await getSheetGid();

    const sortedRows = rows
      .filter(r => r && r.boss && r.time)
      .map(r => {
        const time = String(r.time).trim();
        const hour = parseInt(time.split(':')[0], 10);
        // หัวตารางในภาพระบุ "วันที่แบบ server day (UTC+8)" แต่เวลาที่ดึงมาคือคอลัมน์ UTC+7
        // (เวลาไทย) ซึ่งช้ากว่า UTC+8 อยู่ 1 ชั่วโมง ผลคือช่วงเวลา 23:00-23:59 (UTC+7) ยังอยู่ใน
        // "วันเดิม" ของเวลาไทย แต่ตกไปอยู่ใน server-day (UTC+8) ของวันถัดไปแล้ว — ต้องลบวันที่ที่
        // อ่านมาจากหัวตารางออก 1 วัน เพื่อให้ตรงกับเวลาไทยจริงๆ ก่อนบันทึกลงชีต (ซึ่งใช้เวลาไทยล้วน)
        let rowDate = date;
        if (!Number.isNaN(hour) && hour === 23) {
          const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10)));
          d.setUTCDate(d.getUTCDate() - 1);
          const p2 = n => String(n).padStart(2, '0');
          rowDate = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
        }
        return { boss: String(r.boss).trim(), dt: `${rowDate} ${time}` };
      })
      .sort((a, b) => a.dt.localeCompare(b.dt));

    let added = 0, skipped = 0, updated = 0;
    for (const { boss, dt } of sortedRows) {
      // ดึงข้อมูลสดทุกรอบ เผื่อคอลัมน์เลื่อนไปจากการแทรกรอบก่อนหน้า
      const freshRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A1:ZZ10` });
      const freshRows = freshRes.data.values || [];
      const freshBossRow = freshRows[bossRowIdx] || [];
      const freshDateRow = freshRows[dateRowIdx] || [];

      let gdCol = freshBossRow.length;
      for (let c = memberCol + 1; c < freshBossRow.length; c++) {
        if ((freshBossRow[c] || '').toUpperCase().startsWith('GD')) { gdCol = c; break; }
      }

      const bossLower = boss.toLowerCase();
      let closestCol = -1, closestDiff = Infinity, insertAt = gdCol;
      for (let c = memberCol + 1; c < gdCol; c++) {
        const cellBoss = (freshBossRow[c] || '').toLowerCase();
        const cellDate = freshDateRow[c] || '';
        if (cellBoss.includes(bossLower)) {
          const diff = minutesDiff(cellDate, dt);
          if (diff < closestDiff) { closestDiff = diff; closestCol = c; }
        }
        if (insertAt === gdCol && cellDate > dt) insertAt = c;
      }

      if (closestCol !== -1 && closestDiff <= 5) {
        // ถือว่าเป็นบอสตัวเดียวกัน (ห่างกันไม่เกิน 5 นาที) → ปรับเวลาให้ตรงกับตารางล่าสุดแทนการแทรกใหม่
        if (closestDiff === 0) { skipped++; continue; } // เวลาตรงเป๊ะอยู่แล้ว ไม่ต้องทำอะไร
        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range: `${SHEET_NAME}!${colToLetter(closestCol)}${dateRowIdx + 1}`,
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [[dt]] },
        });
        updated++;
        continue;
      }

      const level = getBossLevel(boss);
      const mandatory = MANDATORY_BOSSES.has(bossLower) || [...MANDATORY_BOSSES].some(m => bossLower.includes(m));
      const headerText = `Lv.${level} ${boss}`;
      const bg = mandatory ? { red: 0.698, green: 0.227, blue: 0.290 } : { red: 0.914, green: 0.769, blue: 0.416 };

      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: {
          requests: [
            { insertDimension: { range: { sheetId: gid, dimension: 'COLUMNS', startIndex: insertAt, endIndex: insertAt + 1 }, inheritFromBefore: false } },
            { repeatCell: {
                range: { sheetId: gid, startRowIndex: bossRowIdx, endRowIndex: dateRowIdx + 1, startColumnIndex: insertAt, endColumnIndex: insertAt + 1 },
                cell: { userEnteredFormat: { backgroundColor: bg } },
                fields: 'userEnteredFormat.backgroundColor',
            } },
          ],
        },
      });
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!${colToLetter(insertAt)}${bossRowIdx + 1}:${colToLetter(insertAt)}${dateRowIdx + 1}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[headerText], [dt]] },
      });
      added++;
    }

    await message.reactions.removeAll().catch(() => {});
    await message.react('✅');
    await message.reply(`✅ อัปเดตตารางบอสวันที่ ${date} แล้ว — เพิ่มคอลัมน์ใหม่ ${added} รายการ, ปรับเวลาให้ตรงตารางล่าสุด ${updated} รายการ, ข้ามซ้ำ ${skipped} รายการ`);
  } catch (err) {
    console.error(err);
    await message.reactions.removeAll().catch(() => {});
    try { await message.reply('❌ เกิดข้อผิดพลาดตอนอัปเดตตารางบอส: ' + err.message); } catch (e) {}
  }
}

// หาคอลัมน์ "CP" ในชีต ถ้ายังไม่มีให้แทรกใหม่ต่อจากคอลัมน์ Score
async function getOrInsertCPColumn() {
  await ensureActiveSheet();
  const hdrRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A1:ZZ10` });
  const hdrRows = hdrRes.data.values || [];
  let labelRowIdx = -1;
  for (let r = 0; r < Math.min(hdrRows.length, 10); r++) {
    if ((hdrRows[r] || []).some(c => (c || '').trim().toLowerCase() === 'member')) { labelRowIdx = r; break; }
  }
  if (labelRowIdx === -1) throw new Error('หาคอลัมน์ Member ในชีตไม่เจอ');
  const row = hdrRows[labelRowIdx] || [];
  let cpCol = row.findIndex(c => (c || '').trim().toLowerCase() === 'cp');
  if (cpCol !== -1) return { cpCol, labelRowIdx };

  const scoreCol = row.findIndex(c => (c || '').trim().toLowerCase() === 'score');
  const insertAt = scoreCol !== -1 ? scoreCol + 1 : row.length;
  const gid = await getSheetGid();
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: { requests: [{ insertDimension: { range: { sheetId: gid, dimension: 'COLUMNS', startIndex: insertAt, endIndex: insertAt + 1 }, inheritFromBefore: false } }] },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!${colToLetter(insertAt)}${labelRowIdx + 1}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [['CP']] },
  });
  return { cpCol: insertAt, labelRowIdx };
}

// ห้องลง CP: พิมพ์ "ชื่อ ค่าCP" + แนบภาพสกรีน CP → AI อ่านค่าจากภาพมาเทียบ ตรงกันถึงจะบันทึก
// ห้อง CP ปกติเปิดเฉพาะวันอาทิตย์ 20:00-21:00 น. (เวลาไทย) — ตั้ง CP_WINDOW_ENFORCED = false ไว้ชั่วคราวตอนทดสอบ
const CP_WINDOW_ENFORCED = true; // เปลี่ยนกลับเป็น true เมื่อเลิกทดสอบ เพื่อบังคับช่วงเวลาอีกครั้ง
function isCPWindowOpen() {
  if (!CP_WINDOW_ENFORCED) return true;
  const now = thaiNowAnchored();
  const day = now.getUTCDay(); // 0 = อาทิตย์
  const hour = now.getUTCHours();
  return day === 0 && hour >= 20 && hour < 21;
}

async function handleCPSubmission(message, image) {

  await message.react('⏳');

  try {

    await ensureActiveSheet();

    const content = message.content.trim();

    const numMatch = content.match(/([\d][\d,]{2,})\s*$/);

    if (!numMatch) {

      await message.reply('⚠️ พิมพ์ชื่อ + ค่า CP ในข้อความเดียวกับที่แนบรูป เช่น "PML 145230"');

      await message.reactions.removeAll().catch(() => {});

      return;

    }

    const typedCP = parseInt(numMatch[1].replace(/,/g, ''), 10);

    const nameText = content.slice(0, numMatch.index).trim();

    if (!nameText) {

      await message.reply('⚠️ พิมพ์ชื่อสมาชิกนำหน้าค่า CP ด้วย เช่น "PML 145230"');

      await message.reactions.removeAll().catch(() => {});

      return;

    }


    const imgRes = await fetch(image.url);

    const imgBuffer = await imgRes.arrayBuffer();

    const base64 = Buffer.from(imgBuffer).toString('base64');

    const mediaType = sniffImageType(imgBuffer) || image.contentType || 'image/png';

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {

      method: 'POST',

      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },

      body: JSON.stringify({

        model: 'claude-sonnet-4-6',

        max_tokens: 300,

        temperature: 0,

        messages: [{

          role: 'user',

          content: [

            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },

            { type: 'text', text: 'นี่คือภาพหน้าจอเกม (มุมมองบุคคลที่สาม กำลังต่อสู้อยู่กลางแมพ) ต้องการอ่าน 2 อย่าง:\n\n(1) "ชื่อตัวละครของผู้เล่นเอง" — ชื่อนี้จะปรากฏเป็น "ป้ายชื่อ (nameplate)" ลอยอยู่เหนือหัวโมเดลตัวละคร 3 มิติที่อยู่กลางฉาก (ตัวละครที่ผู้เล่นกำลังควบคุมอยู่ ซึ่งจะขยับ/โจมตีศัตรูตามการกดปุ่ม) ป้ายชื่อนี้มักมีตัวเลขเล็กๆ ต่อท้ายชื่อ (เช่น "Pedtalay 4") ตัวเลขนั้นคือเลขเลเวลปาร์ตี้ ไม่ใช่ส่วนหนึ่งของชื่อ ให้ตัดออก\n\n**ข้อควรระวัง ห้ามสับสนกับ:**\n- ชื่อผู้เล่นคนอื่นที่อยู่ในฉากเดียวกัน (มีป้ายชื่อลอยอยู่เหนือหัวเหมือนกันแต่เป็นตัวละครอื่นที่ไม่ได้ถูกควบคุมอยู่ตรงกลาง)\n- ชื่อมอนสเตอร์/ศัตรู (มักเป็นข้อความสีแดงหรือสีเหลือง ไม่ใช่ชื่อคน)\n- ข้อความในกล่องแชทที่มุมล่างซ้ายของจอ\n- ชื่อกิลด์หรือแท็กในวงเล็บ/วงเล็บเหลี่ยมที่นำหน้าชื่อผู้เล่น\n\nวิธีสังเกตตัวละครของผู้เล่นเอง: มักอยู่บริเวณกึ่งกลางจอโดยประมาณ (จุดที่กล้องเกมโฟกัส) และเป็นจุดศูนย์กลางของแอ็คชั่นการต่อสู้ (มีเอฟเฟกต์สกิล/ตัวเลขดาเมจแสดงขึ้นรอบตัว)\n\n(2) ค่า "พลังต่อสู้" หรือ "Combat Power" (CP) — มองหาป้ายกำกับ "พลังต่อสู้" (ไทย) หรือ "Combat Power" (อังกฤษ) แล้วอ่านตัวเลขถัดจากป้ายนั้นโดยตรง มักอยู่มุมล่างซ้ายของหน้าจอ (ตัวอย่าง: "พลังต่อสู้ 194,769" → CP คือ 194769) ห้ามสับสนกับเลขเลเวล, เลขอันดับ/#, เปอร์เซ็นต์ Exp, หรือจำนวนทอง/เพชร\n\nถ้าหาป้ายกำกับ CP ไม่เจอเลยให้ใส่ "cp":"0" ถ้าหาชื่อตัวละครของผู้เล่นเองไม่เจอให้ใส่ "name":""\n\nตอบเป็น JSON เท่านั้น ไม่มีคำอธิบายอื่น ไม่มี markdown รูปแบบ {"name":"Pedtalay","cp":"194769"}' },

          ],

        }],

      }),

    });

    const aiData = await aiRes.json();

    if (aiData.error) {

      await message.reply(`❌ เรียก AI ไม่สำเร็จ: ${aiData.error.message || JSON.stringify(aiData.error)}`);

      await message.reactions.removeAll().catch(() => {});

      return;

    }

    const textBlock = (aiData.content || []).find(c => c.type === 'text');

    let readName = '';

    let readCP = 0;

    if (textBlock) {

      try {

        const parsed = JSON.parse(textBlock.text.replace(/```json|```/g, '').trim());

        readName = (parsed.name || '').trim();

        readCP = parseInt(String(parsed.cp || '0').replace(/[^\d]/g, ''), 10) || 0;

      } catch (e) {

        // เผื่อ AI ไม่ตอบเป็น JSON ตามที่สั่ง — fallback ดึงตัวเลขล้วนจากข้อความแทน

        readCP = parseInt((textBlock.text.match(/\d+/) || ['0'])[0], 10) || 0;

      }

    }


    if (!readCP || readCP !== typedCP) {

      await message.reply(`❌ ค่า CP ไม่ตรงกับภาพ — พิมพ์มา: ${typedCP.toLocaleString()} / AI อ่านได้จากภาพ: ${readCP ? readCP.toLocaleString() : 'อ่านไม่ได้'}\nกรุณาตรวจสอบแล้วลองใหม่`);

      await message.reactions.removeAll().catch(() => {});

      return;

    }


    // ตรวจสอบชื่อตัวละครในภาพเทียบกับชื่อที่พิมพ์มา (ถ้า AI อ่านชื่อได้จากภาพ)

    let nameWarning = '';

    if (readName) {

      const a = readName.trim().toLowerCase();

      const b = nameText.trim().toLowerCase();

      const isMatch = a === b || a.includes(b) || b.includes(a) || levenshtein(a, b) <= (b.length <= 4 ? 1 : 2);

      if (!isMatch) {

        await message.reply(`❌ ชื่อตัวละครในภาพ ("${readName}") ไม่ตรงกับชื่อที่พิมพ์มา ("${nameText}")\nกรุณาตรวจสอบแล้วลองใหม่`);

        await message.reactions.removeAll().catch(() => {});

        return;

      }

    } else {

      nameWarning = '\n⚠️ ไม่พบชื่อตัวละครในภาพ (ตรวจสอบเฉพาะค่า CP เท่านั้น)';

    }


    const { cpCol, labelRowIdx } = await getOrInsertCPColumn();

    const dataRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A1:ZZ2000` });

    const rows = dataRes.data.values || [];

    const memberCol = (rows[labelRowIdx] || []).findIndex(c => (c || '').trim().toLowerCase() === 'member');


    let rowIdx = -1;

    for (let r = labelRowIdx + 2; r < rows.length; r++) {

      if ((rows[r][memberCol] || '').trim().toLowerCase() === nameText.toLowerCase()) { rowIdx = r; break; }

    }

    if (rowIdx === -1) {

      for (let r = labelRowIdx + 2; r < rows.length; r++) {

        const name = (rows[r][memberCol] || '').trim().toLowerCase();

        if (name && (name.includes(nameText.toLowerCase()) || nameText.toLowerCase().includes(name))) { rowIdx = r; break; }

      }

    }

    if (rowIdx === -1) {

      await message.reply(`❌ หาชื่อ "${nameText}" ในชีตไม่เจอ`);

      await message.reactions.removeAll().catch(() => {});

      return;

    }


    await sheets.spreadsheets.values.update({

      spreadsheetId: SPREADSHEET_ID,

      range: `${SHEET_NAME}!${colToLetter(cpCol)}${rowIdx + 1}`,

      valueInputOption: 'USER_ENTERED',

      requestBody: { values: [[typedCP]] },

    });


    await message.reactions.removeAll().catch(() => {});

    await message.react('✅');

    await message.reply(`✅ บันทึก CP ของ ${nameText} = ${typedCP.toLocaleString()} แล้ว (ตรงกับภาพ ✓)${nameWarning}`);

  } catch (err) {

    console.error(err);

    await message.reactions.removeAll().catch(() => {});

    try { await message.reply('❌ เกิดข้อผิดพลาด: ' + err.message); } catch (e) {}

  }

}
// ---------------- แจ้งเตือนก่อนบอสเกิด (บอทเช็คพื้นหลังเอง ไม่ต้องมีคนพิมพ์) ----------------
function parseSheetDT(text) {
  const m = String(text).trim().match(/^(\d{4})-(\d{2})-(\d{2}) (\d{1,2}):(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5])));
}
function thaiNowAnchored() {
  const now = new Date();
  const shifted = new Date(now.getTime() + (7 * 60 - now.getTimezoneOffset()) * 60000);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate(), shifted.getUTCHours(), shifted.getUTCMinutes(), shifted.getUTCSeconds()));
}
const alertedKeys = new Set();

async function checkUpcomingSpawns() {
  try {
    await ensureActiveSheet(); // เช็คทุกนาที = จุดที่ทำให้ขึ้นสัปดาห์ใหม่ได้แน่นอนแม้ไม่มีใครพิมพ์อะไรเลย
  } catch (e) { console.error('ensureActiveSheet error', e); }
  if (!ALERT_CHANNEL_ID) return;
  try {
    const hdrRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A1:ZZ10` });
    const hdrRows = hdrRes.data.values || [];
    let labelRowIdx = -1, memberCol = -1;
    for (let r = 0; r < Math.min(hdrRows.length, 10); r++) {
      const idx = (hdrRows[r] || []).findIndex(c => (c || '').trim().toLowerCase() === 'member');
      if (idx !== -1) { labelRowIdx = r; memberCol = idx; break; }
    }
    if (labelRowIdx === -1) return;
    const bossRow = hdrRows[labelRowIdx] || [];
    const dateRow = hdrRows[labelRowIdx + 1] || [];
    const now = thaiNowAnchored();

    for (let c = memberCol + 1; c < bossRow.length; c++) {
      const bossName = bossRow[c];
      const dateText = dateRow[c];
      if (!bossName || !dateText) continue;
      if (bossName.toUpperCase().startsWith('GD')) continue;
      const dt = parseSheetDT(dateText);
      if (!dt) continue;
      const diffMin = (dt.getTime() - now.getTime()) / 60000;
      const key = `${bossName}|${dateText}`;
      if (diffMin > 0 && diffMin <= ALERT_MINUTES && !alertedKeys.has(key)) {
        alertedKeys.add(key);
        try {
          const channel = await client.channels.fetch(ALERT_CHANNEL_ID);
          await channel.send(`⏰ **${bossName}** จะเกิดในอีกประมาณ ${Math.ceil(diffMin)} นาที! (${dateText.split(' ')[1] || ''})`);
        } catch (e) { console.error('ส่งแจ้งเตือนไม่สำเร็จ', e); }
      }
    }
  } catch (err) {
    console.error('checkUpcomingSpawns error', err);
  }
}

// คูลดาวน์ (ชั่วโมง) ของบอสแบบ "รอบเกิด" เท่านั้น — บอสตารางตายตัวไม่ต้องมีในนี้ (ไม่ใช้ !kill)
const COOLDOWN_HOURS = {
  venatus: 10, viorent: 10, ego: 21, livera: 24, araneo: 24, undomiel: 24,
  'general aquleus': 29, 'general aqueles': 29, amentis: 29, baron: 32,
  wannitas: 48, metus: 48, duplican: 48, gareth: 32, shuliar: 35, titore: 37,
  larba: 35, catena: 35, secreta: 62, ordo: 62, asta: 62, supore: 62, 'lady dalia': 18,
};

// แยกชื่อบอส/เวลา/yesterday-today ออกจากข้อความ !kill (ตามรูปแบบของ RaidScout)
function parseKillArgs(text) {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  let explicitDay = null;   // 'yesterday' | 'today' (คำสัมพัทธ์ แบบเดิม ยังรองรับไว้)
  let explicitDate = null;  // { day, month, year } จากการพิมพ์วันที่ตรงๆ แบบ DD/MM หรือ DD/MM/YYYY
  let rejectedDateToken = null;
  const dayWords = ['yesterday', 'today', 'เมื่อวาน', 'วันนี้'];
  if (parts.length) {
    const last = parts[parts.length - 1];
    const dm = last.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
    if (dm) {
      const day = +dm[1], month = +dm[2], year = dm[3] ? (dm[3].length === 2 ? 2000 + (+dm[3]) : +dm[3]) : null;
      if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
        explicitDate = { day, month, year };
      } else {
        rejectedDateToken = last;
      }
      parts.pop();
    } else if (dayWords.includes(last.toLowerCase())) {
      const w = parts.pop().toLowerCase();
      explicitDay = (w === 'เมื่อวาน') ? 'yesterday' : (w === 'วันนี้') ? 'today' : w;
    }
  }
  let timeStr = null;
  let rejectedTimeToken = null;
  if (parts.length) {
    const last = parts[parts.length - 1];
    // ยอมรับ "20:30", "20.30", "20：30" (colon เต็มความกว้างจากคีย์บอร์ดมือถือ), มี "น." หรือ "น" ต่อท้ายได้
    const normalized = last
      .replace(/：/g, ':')
      .replace(/\./g, ':')
      .replace(/น\.?$/u, '');
    const m = normalized.match(/^(\d{1,2}):(\d{2})$/);
    if (m) {
      const hh = String(Math.min(23, +m[1])).padStart(2, '0');
      timeStr = `${hh}:${m[2]}`;
      parts.pop();
    } else if (/\d{1,2}[:.：]\d{2}/.test(last)) {
      // มีลักษณะคล้ายเวลาแต่ parse ไม่ผ่าน (เช่น ชั่วโมง/นาทีเกินช่วง) — เตือนแทนที่จะเงียบแล้วใช้เวลาปัจจุบัน
      rejectedTimeToken = last;
      parts.pop();
    }
  }
  return { bossText: parts.join(' '), timeStr, explicitDay, explicitDate, rejectedTimeToken, rejectedDateToken };
}

function fmtSheetDT(d) {
  const p2 = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`;
}

// แทรกคอลัมน์ใหม่ หรืออัปเดตเวลาคอลัมน์เดิม (ถ้าห่างกันไม่เกิน 5 นาที ถือว่าเป็นรอบเดียวกัน) — ใช้ร่วมกับ !kill
async function insertOrUpdateBossColumn(bossQuery, dt) {
  await ensureActiveSheet();
  const hdrRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A1:ZZ10` });
  const hdrRows = hdrRes.data.values || [];
  let labelRowIdx = -1, memberCol = -1;
  for (let r = 0; r < Math.min(hdrRows.length, 10); r++) {
    const idx = (hdrRows[r] || []).findIndex(c => (c || '').trim().toLowerCase() === 'member');
    if (idx !== -1) { labelRowIdx = r; memberCol = idx; break; }
  }
  if (labelRowIdx === -1) throw new Error('หาคอลัมน์ Member ในชีตไม่เจอ');
  const bossRow = hdrRows[labelRowIdx] || [];
  const dateRow = hdrRows[labelRowIdx + 1] || [];

  let gdCol = bossRow.length;
  for (let c = memberCol + 1; c < bossRow.length; c++) {
    if ((bossRow[c] || '').toUpperCase().startsWith('GD')) { gdCol = c; break; }
  }

  let closestCol = -1, closestDiff = Infinity, insertAt = gdCol;
  for (let c = memberCol + 1; c < gdCol; c++) {
    const cellBoss = (bossRow[c] || '').toLowerCase();
    const cellDate = dateRow[c] || '';
    if (cellBoss.includes(bossQuery)) {
      const diff = minutesDiff(cellDate, dt);
      if (diff < closestDiff) { closestDiff = diff; closestCol = c; }
    }
    if (insertAt === gdCol && cellDate > dt) insertAt = c;
  }

  if (closestCol !== -1 && closestDiff <= 5) {
    if (closestDiff > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET_NAME}!${colToLetter(closestCol)}${labelRowIdx + 2}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [[dt]] },
      });
      return { action: 'updated', dt };
    }
    return { action: 'unchanged', dt };
  }

  const level = getBossLevel(bossQuery);
  const mandatory = MANDATORY_BOSSES.has(bossQuery) || [...MANDATORY_BOSSES].some(m => bossQuery.includes(m));
  const headerText = `Lv.${level} ${bossQuery.charAt(0).toUpperCase() + bossQuery.slice(1)}`;
  const bg = mandatory ? { red: 0.698, green: 0.227, blue: 0.290 } : { red: 0.914, green: 0.769, blue: 0.416 };
  const gid = await getSheetGid();
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        { insertDimension: { range: { sheetId: gid, dimension: 'COLUMNS', startIndex: insertAt, endIndex: insertAt + 1 }, inheritFromBefore: false } },
        { repeatCell: {
            range: { sheetId: gid, startRowIndex: labelRowIdx, endRowIndex: labelRowIdx + 2, startColumnIndex: insertAt, endColumnIndex: insertAt + 1 },
            cell: { userEnteredFormat: { backgroundColor: bg } },
            fields: 'userEnteredFormat.backgroundColor',
        } },
      ],
    },
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!${colToLetter(insertAt)}${labelRowIdx + 1}:${colToLetter(insertAt)}${labelRowIdx + 2}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[headerText], [dt]] },
  });
  return { action: 'inserted', dt };
}

// ---------------------------------------------------------------------------
// อัปเดตคอลัมน์ "Last Kill Date" / "Last Kill Time (UTC+7)" ในชีต Boss Spawn Tracker
// (ไฟล์ Google Sheet คนละไฟล์กับ Attendance ตั้งค่าผ่าน BOSS_TRACKER_SPREADSHEET_ID)
// ใช้เฉพาะบอสแบบคูลดาวน์เท่านั้น — บอสตารางตายตัว (มี WD1/T1 เป็นสูตรคำนวณเอง) ไม่ต้องแตะ
// เขียนเฉพาะ "แถวฐาน" ของบอสตัวนั้น (แถวที่ไม่มีข้อความ "spawn #N today" ต่อท้าย) เพราะแถวที่มี
// "spawn #2/#3 today" เป็นแถวคำนวณล่วงหน้าต่อเนื่องจากแถวฐาน ไม่ใช่แถวที่กรอกเวลาตายจริง
// ---------------------------------------------------------------------------
async function updateBossTrackerLastKill(bossKey, killDate) {
  if (!BOSS_TRACKER_SPREADSHEET_ID) return { skipped: true, reason: 'no-env' };

  const hdrRes = await sheets.spreadsheets.values.get({
    spreadsheetId: BOSS_TRACKER_SPREADSHEET_ID,
    range: `${BOSS_TRACKER_SHEET_NAME}!A1:Z10`,
  });
  const hdrRows = hdrRes.data.values || [];
  let headerRowIdx = -1, bossCol = -1, dateCol = -1, timeCol = -1;
  for (let r = 0; r < Math.min(hdrRows.length, 10); r++) {
    const row = hdrRows[r] || [];
    const bIdx = row.findIndex(c => (c || '').trim().toLowerCase() === 'boss');
    const dIdx = row.findIndex(c => (c || '').trim().toLowerCase() === 'last kill date');
    const tIdx = row.findIndex(c => (c || '').trim().toLowerCase().startsWith('last kill time'));
    if (bIdx !== -1 && dIdx !== -1 && tIdx !== -1) {
      headerRowIdx = r; bossCol = bIdx; dateCol = dIdx; timeCol = tIdx;
      break;
    }
  }
  if (headerRowIdx === -1) return { skipped: true, reason: 'header-not-found' };

  const dataRes = await sheets.spreadsheets.values.get({
    spreadsheetId: BOSS_TRACKER_SPREADSHEET_ID,
    range: `${BOSS_TRACKER_SHEET_NAME}!A${headerRowIdx + 2}:Z500`,
  });
  const dataRows = dataRes.data.values || [];

  let targetRow = -1;
  for (let i = 0; i < dataRows.length; i++) {
    const cell = (dataRows[i][bossCol] || '').trim();
    if (!cell) continue;
    if (/spawn\s*#\d+\s*today/i.test(cell)) continue; // ข้ามแถวคำนวณล่วงหน้า เอาแค่แถวฐาน
    const m = cell.match(/\(([A-Za-z][A-Za-z\s]*)\)/); // ดึงชื่ออังกฤษในวงเล็บ เช่น "เวนาดัส (Venatus)" -> "Venatus"
    const english = (m ? m[1] : cell).trim().toLowerCase();
    if (english === bossKey || english.includes(bossKey) || bossKey.includes(english)) {
      targetRow = headerRowIdx + 2 + i; // เลขแถวจริงใน sheet (1-indexed)
      break;
    }
  }
  if (targetRow === -1) return { skipped: true, reason: 'boss-row-not-found' };

  const p2 = n => String(n).padStart(2, '0');
  const dateStr = `${killDate.getUTCFullYear()}-${p2(killDate.getUTCMonth() + 1)}-${p2(killDate.getUTCDate())}`;
  const timeStr = `${p2(killDate.getUTCHours())}:${p2(killDate.getUTCMinutes())}:00`;

  await sheets.spreadsheets.values.update({
    spreadsheetId: BOSS_TRACKER_SPREADSHEET_ID,
    range: `${BOSS_TRACKER_SHEET_NAME}!${colToLetter(dateCol)}${targetRow}:${colToLetter(timeCol)}${targetRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[dateStr, timeStr]] },
  });
  return { updated: true, row: targetRow };
}


// คำสั่ง !fixnames — ไล่เช็คหัวคอลัมน์บอสทั้งหมดในชีตปัจจุบัน แก้ชื่อที่สะกดไม่ตรงมาตรฐานให้ถูกต้อง
// คำสั่ง !maintenance [HH:MM] — ตอนเซิร์ฟปิดปรับปรุง บอสรอบเกิดทุกตัวจะเกิดพร้อมกันหมดทันทีตอนเซิร์ฟกลับมา
// (ไม่ต้องรอคูลดาวน์อีกรอบ) คำสั่งนี้เขียนเวลา = เวลาเซิร์ฟกลับมาตรงๆ ให้ทุกบอสพร้อมกัน
async function handleMaintenanceCommand(message, timeStr) {
  await message.react('⏳');
  try {
    const now = thaiNowAnchored();
    let restartTime = now;
    if (timeStr) {
      const [h, m] = timeStr.split(':').map(Number);
      restartTime = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));
    }

    // รวมบอสรอบเกิดที่ไม่ซ้ำกัน (COOLDOWN_HOURS มีสะกดซ้ำของบอสตัวเดียวกันปนอยู่)
    const uniqueBosses = new Map();
    for (const [key, cd] of Object.entries(COOLDOWN_HOURS)) {
      const canon = resolveBossName(key) || key;
      uniqueBosses.set(canon, cd);
    }

    const dt = fmtSheetDT(restartTime); // บอสทุกตัวเกิดพร้อมกันทันที ณ เวลาเซิร์ฟกลับมา
    const results = [];
    for (const [boss] of uniqueBosses) {
      try {
        const r = await insertOrUpdateBossColumn(boss, dt);
        results.push(`${boss} → ${dt} (${r.action})`);
      } catch (e) {
        results.push(`${boss} → ❌ ${e.message}`);
      }
    }

    await message.reactions.removeAll().catch(() => {});
    await message.react('✅');
    const preview = results.slice(0, 25).join('\n');
    const more = results.length > 25 ? `\n...และอีก ${results.length - 25} ตัว` : '';
    await message.reply(`✅ รีเซ็ตเวลาบอสรอบเกิดทั้งหมด ${uniqueBosses.size} ตัว ให้เกิดพร้อมกันจากเวลาเซิร์ฟกลับมา (${fmtSheetDT(restartTime)}):\n${preview}${more}`);
  } catch (err) {
    console.error(err);
    await message.reactions.removeAll().catch(() => {});
    try { await message.reply('❌ เกิดข้อผิดพลาด: ' + err.message); } catch (e) {}
  }
}

async function handleFixNamesCommand(message) {
  await message.react('⏳');
  try {
    await ensureActiveSheet();
    const hdrRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range: `${SHEET_NAME}!A1:ZZ10` });
    const hdrRows = hdrRes.data.values || [];
    let labelRowIdx = -1, memberCol = -1;
    for (let r = 0; r < Math.min(hdrRows.length, 10); r++) {
      const idx = (hdrRows[r] || []).findIndex(c => (c || '').trim().toLowerCase() === 'member');
      if (idx !== -1) { labelRowIdx = r; memberCol = idx; break; }
    }
    if (labelRowIdx === -1) {
      await message.reply('❌ หาคอลัมน์ Member ในชีตไม่เจอ');
      await message.reactions.removeAll().catch(() => {});
      return;
    }
    const bossRow = hdrRows[labelRowIdx] || [];

    const updates = [];
    const changes = [];
    for (let c = memberCol + 1; c < bossRow.length; c++) {
      const cellText = (bossRow[c] || '').trim();
      if (!cellText || cellText.toUpperCase().startsWith('GD')) continue;
      const m = cellText.match(/^Lv\.(\d+)\s+(.+)$/i);
      const namePart = m ? m[2] : cellText;
      const levelPart = m ? m[1] : String(getBossLevel(namePart));
      const canonical = resolveBossName(namePart);
      if (!canonical) continue; // ไม่รู้จัก ข้ามไป ไม่แตะ
      const correctText = `Lv.${levelPart} ${canonical.charAt(0).toUpperCase() + canonical.slice(1)}`;
      if (correctText !== cellText) {
        updates.push({ range: `${SHEET_NAME}!${colToLetter(c)}${labelRowIdx + 1}`, values: [[correctText]] });
        changes.push(`${cellText} → ${correctText}`);
      }
    }

    if (updates.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { valueInputOption: 'USER_ENTERED', data: updates },
      });
    }

    await message.reactions.removeAll().catch(() => {});
    await message.react('✅');
    if (!changes.length) {
      await message.reply('✅ ตรวจสอบแล้ว — ชื่อบอสในชีตสะกดถูกต้องหมดทุกคอลัมน์อยู่แล้ว ไม่มีอะไรต้องแก้');
    } else {
      const preview = changes.slice(0, 20).join('\n');
      const more = changes.length > 20 ? `\n...และอีก ${changes.length - 20} รายการ` : '';
      await message.reply(`✅ แก้ไขชื่อบอสแล้ว ${changes.length} คอลัมน์:\n${preview}${more}`);
    }
  } catch (err) {
    console.error(err);
    await message.reactions.removeAll().catch(() => {});
    try { await message.reply('❌ เกิดข้อผิดพลาด: ' + err.message); } catch (e) {}
  }
}

async function handleKillCommand(message) {
  const raw = message.content.replace(/^!kill\s*/i, '');
  const { bossText, timeStr, explicitDay, explicitDate, rejectedTimeToken, rejectedDateToken } = parseKillArgs(raw);
  if (!bossText) {
    await message.reply('รูปแบบ: `!kill <ชื่อบอส> [HH:MM] [DD/MM]`\nตัวอย่าง: `!kill Venatus` หรือ `!kill Venatus 20:30 03/09`\n(เวลาพิมพ์ `20.30` แทน `:` ก็ได้ ส่วนวันที่จะพิมพ์ `yesterday`/`เมื่อวาน` แทนก็ยังใช้ได้เหมือนเดิม)');
    return;
  }
  const bossQuery = resolveBossName(bossText);
  if (!bossQuery) {
    await message.reply(`❌ ไม่รู้จักชื่อบอส "${bossText}"`);
    return;
  }
  const cooldown = COOLDOWN_HOURS[bossQuery];
  if (!cooldown) {
    await message.reply(`❌ "${bossQuery}" ไม่ใช่บอสแบบรอบเกิด (คูลดาวน์) — คำสั่งนี้ใช้ได้เฉพาะบอสที่มีรอบเกิดเป็นชั่วโมงเท่านั้น บอสตารางตายตัวไม่ต้องใช้คำสั่งนี้`);
    return;
  }
  if (rejectedDateToken) {
    await message.reply(`❌ อ่านวันที่ "${rejectedDateToken}" ไม่ออก (วันหรือเดือนเกินช่วงที่เป็นไปได้) — ใช้รูปแบบ DD/MM เช่น \`03/09\` แล้วลองพิมพ์คำสั่งใหม่อีกครั้ง`);
    return;
  }
  if (rejectedTimeToken) {
    await message.reply(`❌ อ่านเวลา "${rejectedTimeToken}" ไม่ออก (ชั่วโมงหรือนาทีเกินช่วงที่เป็นไปได้) — ใช้รูปแบบ HH:MM เช่น \`20:30\` แล้วลองพิมพ์คำสั่งใหม่อีกครั้ง`);
    return;
  }

  const now = thaiNowAnchored();
  let killDate = now;
  if (explicitDate) {
    const year = explicitDate.year || now.getUTCFullYear();
    const [h, m] = timeStr ? timeStr.split(':').map(Number) : [now.getUTCHours(), now.getUTCMinutes()];
    killDate = new Date(Date.UTC(year, explicitDate.month - 1, explicitDate.day, h, m));
    // ไม่ได้พิมพ์ปีมา แล้วดันคำนวณได้วันที่ในอนาคตไกลเกินไป (เช่น ข้ามปีใหม่) — เดาว่าหมายถึงปีที่แล้ว
    if (!explicitDate.year && killDate.getTime() - now.getTime() > 24 * 3600000) {
      killDate.setUTCFullYear(killDate.getUTCFullYear() - 1);
    }
  } else if (timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    killDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m));
    if (explicitDay === 'yesterday') {
      killDate.setUTCDate(killDate.getUTCDate() - 1);
    } else if (!explicitDay && killDate.getTime() > now.getTime()) {
      killDate.setUTCDate(killDate.getUTCDate() - 1); // เดาอัตโนมัติ: เวลาตายเป็นอนาคตไม่ได้ → ต้องเป็นเมื่อวาน
    }
  }
  const p2 = n => String(n).padStart(2, '0');
  const killedAtLabel = (timeStr || explicitDate)
    ? `${killDate.getUTCFullYear()}-${p2(killDate.getUTCMonth() + 1)}-${p2(killDate.getUTCDate())} ${p2(killDate.getUTCHours())}:${p2(killDate.getUTCMinutes())} (ตามที่พิมพ์ระบุ)`
    : `${p2(killDate.getUTCHours())}:${p2(killDate.getUTCMinutes())} (ไม่ได้ระบุเวลา — ใช้เวลาที่ส่งข้อความ)`;

  const nextSpawn = new Date(killDate.getTime() + cooldown * 3600000);
  const dt = fmtSheetDT(nextSpawn);

  try {
    const result = await insertOrUpdateBossColumn(bossQuery, dt);
    const label = result.action === 'inserted' ? 'แทรกคอลัมน์ใหม่' : result.action === 'updated' ? 'ปรับเวลาคอลัมน์เดิม' : 'ไม่มีอะไรเปลี่ยน (เวลาตรงเดิมอยู่แล้ว)';
    recordRecentKill(bossQuery, killDate);

    // อัปเดตชีต Boss Spawn Tracker ด้วย (ถ้าตั้งค่า BOSS_TRACKER_SPREADSHEET_ID ไว้) — ไม่ให้ล้มทั้งคำสั่งถ้าจุดนี้พัง
    let trackerNote = '';
    try {
      const trackerResult = await updateBossTrackerLastKill(bossQuery, killDate);
      if (trackerResult.updated) trackerNote = '\n📋 อัปเดต Boss Spawn Tracker ให้ด้วยแล้ว';
      else if (trackerResult.reason === 'boss-row-not-found') trackerNote = `\n⚠️ หาแถวของ "${bossQuery}" ใน Boss Spawn Tracker ไม่เจอ (อัปเดตให้ไม่ได้)`;
    } catch (trackerErr) {
      console.error('updateBossTrackerLastKill error', trackerErr);
      trackerNote = '\n⚠️ อัปเดต Boss Spawn Tracker ไม่สำเร็จ (แต่บันทึกใน Attendance เรียบร้อยแล้ว)';
    }

    await message.reply(`✅ บันทึกเวลาตาย **${bossQuery}** ตอน ${killedAtLabel} (${label}) — เกิดใหม่ประมาณ ${dt} (คำนวณจากคูลดาวน์ ${cooldown} ชม.)${trackerNote}`);
  } catch (err) {
    console.error(err);
    await message.reply('❌ เกิดข้อผิดพลาด: ' + err.message);
  }
}

/* ---------------- Discord client ---------------- */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

client.once('ready', () => {
  console.log(`✅ บอทออนไลน์แล้ว: ${client.user.tag}`);
  setInterval(checkUpcomingSpawns, 60 * 1000);
  checkUpcomingSpawns();
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;

    if (COMMANDS_CHANNEL_ID && message.channel.id === COMMANDS_CHANNEL_ID && /^!kill\b/i.test(message.content.trim())) {
      await handleKillCommand(message);
      return;
    }

    if (COMMANDS_CHANNEL_ID && message.channel.id === COMMANDS_CHANNEL_ID && /^!fixnames\b/i.test(message.content.trim())) {
      await handleFixNamesCommand(message);
      return;
    }

    if (COMMANDS_CHANNEL_ID && message.channel.id === COMMANDS_CHANNEL_ID && /^!maintenance\b/i.test(message.content.trim())) {
      const arg = message.content.replace(/^!maintenance\s*/i, '').trim();
      const timeMatch = /^\d{1,2}:\d{2}$/.test(arg) ? arg : null;
      await handleMaintenanceCommand(message, timeMatch);
      return;
    }

    if (CP_CHANNEL_ID && message.channel.id === CP_CHANNEL_ID) {
      if (!isCPWindowOpen()) {
        await message.reply('⏰ ห้องนี้เปิดให้ลง CP เฉพาะ **วันอาทิตย์ เวลา 20:00–21:00 น.** เท่านั้น กรุณากลับมาใหม่ในช่วงเวลาดังกล่าว');
        return;
      }
      const image = message.attachments.find(a => (a.contentType || '').startsWith('image/'));
      if (!image) {
        await message.reply('⚠️ พิมพ์ชื่อ + ค่า CP พร้อมแนบรูปสกรีน CP ในข้อความเดียวกัน เช่น "PML 145230"');
        return;
      }
      await handleCPSubmission(message, image);
      return;
    }

    if (message.channel.id !== CHECKIN_CHANNEL_ID) return;
    const image = message.attachments.find(a => (a.contentType || '').startsWith('image/'));
    if (!image) return;

    const bossNameRaw = message.content.trim();
    if (!bossNameRaw) {
      await handleScheduleImage(message, image);
      return;
    }
    const typedDate = parseTypedDate(bossNameRaw);
    const afterDateText = typedDate ? bossNameRaw.replace(typedDate.raw, '').trim() : bossNameRaw;
    const typedTime = parseTypedTime(afterDateText);
    const bossTextOnly = typedTime ? afterDateText.replace(typedTime.raw, '').trim() : afterDateText;
    const bossQuery = resolveBossName(bossTextOnly); // ชื่ออังกฤษมาตรฐาน รองรับไทย/อังกฤษ/สะกดเพี้ยน
    if (!bossQuery) {
      await message.reply(`❌ ไม่รู้จักชื่อบอส "${bossNameRaw}" — เช็คการสะกด หรือเพิ่มบอสนี้ในโค้ดบอทก่อน (NAME_LEVEL / THAI_BOSS_NAMES / BOSS_POINTS)`);
      return;
    }
    const points = getBossPoints(bossQuery);
    if (points === null) {
      await message.reply(`❌ ไม่รู้จักคะแนนของบอส "${bossNameRaw}" — เช็คการสะกด หรือเพิ่มบอสนี้ในตาราง BOSS_POINTS ในโค้ดบอทก่อน`);
      return;
    }

    await message.react('⏳');
    await ensureActiveSheet();

    // 1) อ่านภาพด้วย AI (แยกชื่อปกติ = เข้าร่วม / ชื่อสีเทาจาง = ขาด)
    const imgRes = await fetch(image.url);
    const imgBuffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(imgBuffer).toString('base64');
    const mediaType = sniffImageType(imgBuffer) || image.contentType || 'image/png';
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 600,
        temperature: 0,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: 'ดึงรายชื่อตัวละคร/สมาชิกทั้งหมดที่มองเห็นในภาพนี้ แยกเป็น 2 กลุ่ม: "attended" คือชื่อที่ขึ้นสีปกติ/สีขาวสว่างชัดเจน (เข้าร่วม) และ "absent" คือเฉพาะชื่อที่มีสีเทาหม่น/จางกว่าชื่ออื่นอย่างชัดเจนมากจนสังเกตเห็นได้ง่าย (ไม่ได้เข้าร่วม) หากไม่แน่ใจหรือความจางไม่ชัดเจนพอ ให้จัดเป็น "attended" ไว้ก่อนเสมอ (ระวังพลาดเป็น absent ทั้งที่จริงเข้าร่วม สำคัญกว่าพลาดเป็น attended ทั้งที่จริงขาด) ตอบเป็น JSON object เท่านั้น รูปแบบ {"attended":["Name1","Name2"],"absent":["Name3"]} ถ้ากลุ่มไหนไม่มีให้ใส่ array ว่าง []' },
          ],
        }],
      }),
    });
    const aiData = await aiRes.json();
    if (aiData.error) {
      await message.reply(`❌ เรียก AI ไม่สำเร็จ: ${aiData.error.message || JSON.stringify(aiData.error)}`);
      await message.reactions.removeAll().catch(() => {});
      return;
    }
    const textBlock = (aiData.content || []).find(c => c.type === 'text');
    let detectedNames = [];
    let absentNames = [];
    if (textBlock) {
      try {
        const parsed = JSON.parse(textBlock.text.replace(/```json|```/g, '').trim());
        if (Array.isArray(parsed)) {
          detectedNames = parsed; // เผื่อ AI ตอบกลับเป็น array เปล่าๆ แบบเดิม
        } else {
          detectedNames = parsed.attended || [];
          absentNames = parsed.absent || [];
        }
      } catch (e) {}
    }
    if (!detectedNames.length && !absentNames.length) {
      await message.reply('⚠️ สแกนภาพแล้วไม่พบชื่อเลย กรุณาตรวจสอบภาพหรือกรอกด้วยมือแทน');
      await message.reactions.removeAll().catch(() => {});
      return;
    }

    // 2) อ่านชีตปัจจุบันทั้งหมด (header rows + ข้อมูล)
    const range = `${SHEET_NAME}!A1:ZZ500`;
    const sheetRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
    const rows = sheetRes.data.values || [];

    // หาแถวที่มีคำว่า "Member" อัตโนมัติ (ไม่สมมติตำแหน่งตายตัว เผื่อชีตมีแถวหัวเรื่อง/แถวว่างแทรกอยู่ด้านบน)
    let labelRowIdx = -1, memberCol = -1;
    for (let r = 0; r < Math.min(rows.length, 10); r++) {
      const idx = (rows[r] || []).findIndex(c => (c || '').trim().toLowerCase() === 'member');
      if (idx !== -1) { labelRowIdx = r; memberCol = idx; break; }
    }
    if (labelRowIdx === -1) {
      await message.reply('❌ หาคอลัมน์ "Member" ในชีตไม่เจอ (เช็คแถว 1-10) ตรวจสอบว่า SHEET_NAME ตั้งถูกต้องไหม');
      await message.reactions.removeAll().catch(() => {});
      return;
    }
    const bossNameRow = rows[labelRowIdx] || [];        // แถวชื่อบอส (แถวเดียวกับ Member)
    const labelDateRow = rows[labelRowIdx + 1] || [];   // แถววันที่ (แถวถัดจาก Member)

    // 3) หาคอลัมน์ที่ตรงกับบอส + วันที่ (ใช้วันที่ที่พิมพ์กำกับมา ถ้ามี ไม่งั้นใช้วันนี้)
    const today = typedDate ? typedDate.date : thaiDateToday();
    const candidates = [];
    for (let c = memberCol + 1; c < bossNameRow.length; c++) {
      const bossCell = (bossNameRow[c] || '').toLowerCase();
      const dateCell = (labelDateRow[c] || '');
      if (bossCell && bossCell.includes(bossQuery.toLowerCase()) && dateCell.startsWith(today)) {
        candidates.push(c);
      }
    }
    if (candidates.length === 0) {
      await message.reply(`❌ หาคอลัมน์ของ "${bossNameRaw}" วันที่ ${today} ในชีตไม่เจอ — เช็คว่ามีคอลัมน์นี้เตรียมไว้ในชีตแล้วหรือยัง (ถ้าต้องการเช็คชื่อย้อนหลัง พิมพ์วันที่กำกับด้วยได้ เช่น "Clemantis 2026-08-31" หรือ "Clemantis 31/08")`);
      await message.reactions.removeAll().catch(() => {});
      return;
    }

    let targetCol = candidates[0];
    let timeNote = '';

    if (candidates.length > 1) {
      // บอสตัวนี้เกิดหลายรอบวันเดียวกัน → ใช้เวลาที่พิมพ์กำกับ (ถ้ามี) ไม่งั้นใช้เวลาที่ส่งข้อความ (เฉพาะกรณีเช็คของวันนี้เท่านั้น) เทียบหาคอลัมน์ที่เวลาใกล้สุด
      if (!typedTime && typedDate) {
        const list = candidates.map(c => `${colToLetter(c)} (${(labelDateRow[c] || '').split(' ')[1] || '?'})`).join(', ');
        await message.reply(`⚠️ พบคอลัมน์ที่ตรงกับ "${bossNameRaw}" วันที่ ${today} หลายรอบ กรุณาพิมพ์เวลากำกับด้วยเพราะเป็นการเช็คย้อนหลัง เช่น "${bossQuery} ${today} ${(labelDateRow[candidates[0]] || '').split(' ')[1] || ''}": ${list}`);
        await message.reactions.removeAll().catch(() => {});
        return;
      }
      const targetMinutes = typedTime ? typedTime.minutes : thaiNowMinutes();
      const withDiff = candidates.map(c => {
        const timePart = ((labelDateRow[c] || '').split(' ')[1] || '00:00');
        const [hh, mm] = timePart.split(':').map(n => parseInt(n, 10) || 0);
        const colMinutes = hh * 60 + mm;
        let diff = Math.abs(colMinutes - targetMinutes);
        diff = Math.min(diff, 1440 - diff); // กันกรณีข้ามเที่ยงคืน
        return { c, diff, timePart };
      }).sort((a, b) => a.diff - b.diff);

      const best = withDiff[0], second = withDiff[1];
      const closeEnough = best.diff <= 90;              // ห่างจากเวลาที่ใช้อ้างอิงไม่เกิน 90 นาที
      const clearlyBest = !second || (second.diff - best.diff) >= 30; // ไม่สูสีกับตัวเลือกถัดไป

      if (closeEnough && clearlyBest) {
        targetCol = best.c;
        timeNote = typedTime
          ? `\n🕐 มีบอสตัวนี้หลายรอบวันนั้น — เลือกรอบ ${best.timePart} ตามเวลาที่พิมพ์กำกับ`
          : `\n🕐 มีบอสตัวนี้หลายรอบวันนี้ — เลือกรอบ ${best.timePart} ตามเวลาที่ส่งข้อความใกล้สุด`;
      } else {
        const list = withDiff.map(x => `${colToLetter(x.c)} (${x.timePart})`).join(', ');
        await message.reply(`⚠️ พบคอลัมน์ที่ตรงกับ "${bossNameRaw}" วันนั้นหลายรอบ และเวลาไม่ชัดเจนพอจะเลือกอัตโนมัติ: ${list}\nลองพิมพ์เวลากำกับให้ชัดเจนกว่านี้ เช่น "${bossQuery} ${today} ${withDiff[0].timePart}" หรือกรอกด้วยมือแทน`);
        await message.reactions.removeAll().catch(() => {});
        return;
      }
    }

    // โบนัสกลางคืน: ถ้าบอสตายช่วง 02:00-07:00 (ตามเวลาในคอลัมน์ที่เลือก) ได้คะแนน x2
    const resolvedTimePart = (labelDateRow[targetCol] || '').split(' ')[1] || '';
    const resolvedHour = parseInt((resolvedTimePart.split(':')[0] || '99'), 10);
    const isNightBonus = resolvedHour >= 2 && resolvedHour < 7;
    const finalPoints = isNightBonus ? points * 2 : points;

    // 4) จับคู่ชื่อกับแถวสมาชิกในชีต แล้วเตรียมเขียนค่า
    const memberRows = {}; // name(lower) -> row index
    for (let r = labelRowIdx + 2; r < rows.length; r++) {
      const name = (rows[r][memberCol] || '').trim();
      if (name) memberRows[name.toLowerCase()] = r;
    }

    const updates = [];
    const matched = [];
    const fuzzyMatched = [];
    const unmatched = [];
    function matchMemberRow(n) {
      const key = n.trim().toLowerCase();
      let rowIdx = memberRows[key];
      let isFuzzy = false;
      let matchedName = n;

      if (rowIdx === undefined) {
        const foundKey = Object.keys(memberRows).find(k => k.includes(key) || key.includes(k));
        if (foundKey) { rowIdx = memberRows[foundKey]; matchedName = foundKey; }
      }
      if (rowIdx === undefined) {
        let best = null, bestDist = Infinity;
        for (const k of Object.keys(memberRows)) {
          const d = levenshtein(key, k);
          if (d < bestDist) { bestDist = d; best = k; }
        }
        const threshold = key.length <= 4 ? 1 : 2;
        if (best && bestDist <= threshold) { rowIdx = memberRows[best]; matchedName = best; isFuzzy = true; }
      }
      return rowIdx === undefined ? null : { rowIdx, matchedName, isFuzzy };
    }

    detectedNames.forEach(n => {
      const m = matchMemberRow(n);
      if (m) {
        if (m.isFuzzy) fuzzyMatched.push(`${n} → ${m.matchedName}`);
        else matched.push(n);
        const a1 = `${SHEET_NAME}!${colToLetter(targetCol)}${m.rowIdx + 1}`;
        updates.push({ range: a1, values: [[finalPoints]] });
      } else {
        unmatched.push(n);
      }
    });

    const absentMatched = [];
    const absentUnmatched = [];
    absentNames.forEach(n => {
      const m = matchMemberRow(n);
      if (m) {
        absentMatched.push(m.isFuzzy ? `${n} → ${m.matchedName}` : n);
        const a1 = `${SHEET_NAME}!${colToLetter(targetCol)}${m.rowIdx + 1}`;
        updates.push({ range: a1, values: [[0]] });
      } else {
        absentUnmatched.push(n);
      }
    });

    if (updates.length) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        requestBody: { valueInputOption: 'USER_ENTERED', data: updates },
      });
    }

    await message.reactions.removeAll().catch(() => {});
    await message.react('✅');
    const noteFuzzy = fuzzyMatched.length ? `\n🔎 จับคู่แบบใกล้เคียง (ช่วยตรวจสอบอีกที): ${fuzzyMatched.join(', ')}` : '';
    const noteUnmatched = unmatched.length ? `\n⚠️ ไม่พบชื่อในชีต: ${unmatched.join(', ')}` : '';
    const noteAbsent = absentMatched.length ? `\n⬜ ขาด (0 pt — สีเทาในภาพ): ${absentMatched.join(', ')}` : '';
    const noteAbsentUnmatched = absentUnmatched.length ? `\n⚠️ ชื่อขาดที่ไม่พบในชีต: ${absentUnmatched.join(', ')}` : '';
    const nightNote = isNightBonus ? ` 🌙x2` : '';
    await message.reply(
      `✅ กรอกคะแนนแล้ว — **${bossNameRaw}** (${finalPoints} pt${nightNote}) คอลัมน์ ${colToLetter(targetCol)} วันที่ ${today}${timeNote}\n` +
      `บันทึกตรงชื่อ (${matched.length}): ${matched.join(', ')}${noteFuzzy}${noteUnmatched}${noteAbsent}${noteAbsentUnmatched}`
    );
  } catch (err) {
    console.error(err);
    try { await message.reply('❌ เกิดข้อผิดพลาด: ' + err.message); } catch (e) {}
  }
});

/* ---------------- Dashboard API (สำหรับหน้าเว็บ Guild Management) ----------------
   endpoint อ่านอย่างเดียว ไม่มีการเขียนข้อมูลใดๆ — เปิดสาธารณะ ไม่ต้องล็อกอิน (เฟส 1)
   หมายเหตุสำหรับอนาคต: ถ้าจะรองรับหลายกิลด์ ให้เพิ่ม query param เช่น ?guild=xxx
   แล้วแมปไปหา SPREADSHEET_ID ของแต่ละกิลด์แทนการใช้ตัวแปรเดียวแบบตอนนี้ */
async function fetchDashboardData() {
  await ensureActiveSheet();
  const range = `${SHEET_NAME}!A1:ZZ2000`;
  const res = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
  const rows = res.data.values || [];

  let labelRowIdx = -1, memberCol = -1;
  for (let r = 0; r < Math.min(rows.length, 10); r++) {
    const idx = (rows[r] || []).findIndex(c => (c || '').trim().toLowerCase() === 'member');
    if (idx !== -1) { labelRowIdx = r; memberCol = idx; break; }
  }
  if (labelRowIdx === -1) throw new Error('หาคอลัมน์ Member ในชีตไม่เจอ');

  const bossRow = rows[labelRowIdx] || [];
  const dateRow = rows[labelRowIdx + 1] || [];
  const labelRow = rows[labelRowIdx] || [];
  const scoreColIdx = labelRow.findIndex(c => (c || '').trim().toLowerCase() === 'score');
  const cpColIdx = labelRow.findIndex(c => (c || '').trim().toLowerCase() === 'cp');

  const bosses = [];
  for (let c = memberCol + 1; c < bossRow.length; c++) {
    const name = (bossRow[c] || '').trim();
    const dt = (dateRow[c] || '').trim();
    if (!name) continue;
    const isGD = name.toUpperCase().startsWith('GD');
    bosses.push({ name, time: isGD ? null : dt, mandatory: MANDATORY_BOSSES.has(name.toLowerCase().replace(/^lv\.\d+\s*/i, '')) || false, gd: isGD });
  }

  const members = [];
  for (let r = labelRowIdx + 2; r < rows.length; r++) {
    const name = (rows[r][memberCol] || '').trim();
    if (!name) continue;
    const score = scoreColIdx !== -1 ? Number(rows[r][scoreColIdx]) || 0 : 0;
    const cp = cpColIdx !== -1 ? Number((rows[r][cpColIdx] || '').toString().replace(/,/g, '')) || 0 : 0;
    members.push({ name, score, cp });
  }
  members.sort((a, b) => b.score - a.score);

  const cutoff = Date.now() - RECENT_KILL_WINDOW_MS;
  const recentKillsOut = recentKills
    .filter(k => k.recordedAt >= cutoff)
    .map(k => ({ boss: k.boss, killedAt: k.killedAt, recordedAt: k.recordedAt }));

  return { sheetName: SHEET_NAME, generatedAt: fmtSheetDT(thaiNowAnchored()), bosses, members, recentKills: recentKillsOut, serverNowMs: Date.now() };
}

const API_PORT = process.env.PORT || 3001;
http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${API_PORT}`);
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };

  if (req.method === 'OPTIONS') { res.writeHead(204, headers); return res.end(); }

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain', ...headers });
    return res.end('OK');
  }

  if (url.pathname === '/api/dashboard') {
    try {
      const data = await fetchDashboardData();
      res.writeHead(200, headers);
      return res.end(JSON.stringify({ ok: true, ...data }));
    } catch (err) {
      console.error(err);
      res.writeHead(500, headers);
      return res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  }

  res.writeHead(404, headers);
  res.end(JSON.stringify({ ok: false, error: 'not found' }));
}).listen(API_PORT, () => console.log(`🌐 Dashboard API listening on port ${API_PORT}`));

client.login(DISCORD_BOT_TOKEN);
