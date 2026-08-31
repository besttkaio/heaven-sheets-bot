import 'dotenv/config';
import { Client, GatewayIntentBits, Partials } from 'discord.js';
import { google } from 'googleapis';
import fetch from 'node-fetch';

/* ---------------- ENV VARS ต้องตั้งค่าใน Railway ----------------
DISCORD_BOT_TOKEN       = token ของบอทจาก Discord Developer Portal
CHECKIN_CHANNEL_ID      = Channel ID ของห้องที่ให้โพสต์รูป check-in
ANTHROPIC_API_KEY       = API key จาก console.anthropic.com
GOOGLE_SERVICE_ACCOUNT  = เนื้อหา JSON ทั้งไฟล์ของ Service Account key (บรรทัดเดียว)
SPREADSHEET_ID          = ID จาก URL ของ Google Sheet (docs.google.com/spreadsheets/d/{ID}/edit)
SHEET_NAME              = ชื่อแท็บชีตที่จะเขียนลง (เช่น GangDuHee_W1)
------------------------------------------------------------------ */

const {
  DISCORD_BOT_TOKEN,
  CHECKIN_CHANNEL_ID,
  ANTHROPIC_API_KEY,
  GOOGLE_SERVICE_ACCOUNT,
  SPREADSHEET_ID,
  SHEET_NAME,
} = process.env;

if (!DISCORD_BOT_TOKEN || !CHECKIN_CHANNEL_ID || !ANTHROPIC_API_KEY || !GOOGLE_SERVICE_ACCOUNT || !SPREADSHEET_ID || !SHEET_NAME) {
  console.error('❌ ตั้งค่า Environment Variables ไม่ครบ');
  process.exit(1);
}

/* ---------------- ตารางคะแนนต่อบอส (จากกติกากิลด์ HEAVEN) ----------------
   ทุกคนที่เข้าร่วมบอสตัวเดียวกัน ได้ค่าเท่ากันตามนี้ ปรับแก้ตัวเลขได้ตามจริง
   ถ้าเจอชื่อบอสที่ไม่อยู่ในลิสต์นี้ บอทจะแจ้งเตือนแทนการเดา */
const BOSS_POINTS = {
  // บอสทั่วไป = 1 คะแนน
  'venatus': 1, 'viorent': 1, 'ego': 1, 'clemantis': 1, 'livera': 1, 'araneo': 1,
  'undomiel': 1, 'saphirus': 1, 'neutro': 1, 'lady dalia': 1, 'general aqueles': 1,
  'general aquleus': 1, 'thymele': 1, 'amentis': 1, 'baron braudmore': 1, 'milavy': 1,
  'millavy': 1, 'wannitas': 1, 'wannitus': 1, 'metus': 1, 'duplican': 1, 'shuliar': 1,
  'ringor': 1, 'roderick': 1, 'gareth': 1, 'tiyore': 1, 'titore': 1, 'larba': 1,
  // Boss Lv.100 = 1.5 คะแนน
  'catena': 1.5, 'orgue': 1.5, 'secreta': 1.5, 'ordo': 1.5, 'asta': 1.5, 'supore': 1.5,
  // Auraq Boss = 3 คะแนน (แยกจาก Lv.100 ทั่วไป)
  'auraq': 3,
  // Boss Lv.120 = 3 คะแนน
  'chiflock': 3, 'chaiflock': 3, 'benji': 3,
  // Boss Lv.135+ = 10 คะแนน
  'libitina': 10, 'rakejeth': 10, 'lacases': 10, 'icarutier': 10, 'icaruthia': 10,
  'motti': 10, 'kamalia': 10, 'nevaeh': 10, 'tumer': 10, 'tumier': 10, 'lucus': 10,
  // Guild Dungeon = 5 คะแนน
  'gd1': 5, 'gd2': 5, 'gd3': 5,
};

function getBossPoints(name) {
  const key = name.trim().toLowerCase();
  if (BOSS_POINTS[key]) return BOSS_POINTS[key];
  const found = Object.keys(BOSS_POINTS).find(k => key.includes(k) || k.includes(key));
  return found ? BOSS_POINTS[found] : null;
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

// ดึงชื่อบอสภาษาอังกฤษออกมาใช้เทียบเสมอ (รองรับทั้งพิมพ์แค่ชื่ออังกฤษ และก็อปแบบ "ไทย (English)" มาทั้งดุ้น)
function extractBossQuery(raw) {
  const m = raw.match(/\(([A-Za-z0-9\s]+)\)/);
  return (m ? m[1] : raw).trim();
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

/* ---------------- Discord client ---------------- */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  partials: [Partials.Channel],
});

client.once('ready', () => console.log(`✅ บอทออนไลน์แล้ว: ${client.user.tag}`));

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (message.channel.id !== CHECKIN_CHANNEL_ID) return;
    const image = message.attachments.find(a => (a.contentType || '').startsWith('image/'));
    if (!image) return;

    const bossNameRaw = message.content.trim();
    if (!bossNameRaw) {
      await message.reply('⚠️ พิมพ์ชื่อบอสในข้อความเดียวกับที่แนบรูป เช่น พิมพ์ "Icarutier" แล้วแนบรูป check-in (ถ้าบอสนี้เกิดซ้ำวันเดียวกันหลายรอบ พิมพ์เวลากำกับด้วยได้ เช่น "Icarutier 20:00")');
      return;
    }
    const typedTime = parseTypedTime(bossNameRaw);
    const bossTextOnly = typedTime ? bossNameRaw.replace(typedTime.raw, '').trim() : bossNameRaw;
    const bossQuery = extractBossQuery(bossTextOnly); // ชื่ออังกฤษล้วน ใช้เทียบทุกที่
    const points = getBossPoints(bossQuery);
    if (points === null) {
      await message.reply(`❌ ไม่รู้จักคะแนนของบอส "${bossNameRaw}" — เช็คการสะกด หรือเพิ่มบอสนี้ในตาราง BOSS_POINTS ในโค้ดบอทก่อน`);
      return;
    }

    await message.react('⏳');


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
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: 'ดึงรายชื่อตัวละคร/สมาชิกทั้งหมดที่มองเห็นในภาพนี้ แยกเป็น 2 กลุ่ม: "attended" คือชื่อที่ขึ้นสีปกติ (เข้าร่วม) และ "absent" คือชื่อที่มีสีเทา/จางกว่าปกติ (ไม่ได้เข้าร่วม) ตอบเป็น JSON object เท่านั้น รูปแบบ {"attended":["Name1","Name2"],"absent":["Name3"]} ถ้ากลุ่มไหนไม่มีให้ใส่ array ว่าง []' },
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

    // 3) หาคอลัมน์ที่ตรงกับบอส + วันที่วันนี้ (ไล่ทุกคอลัมน์หลัง Member ไป ไม่สมมติระยะห่างตายตัว)
    const today = thaiDateToday();
    const candidates = [];
    for (let c = memberCol + 1; c < bossNameRow.length; c++) {
      const bossCell = (bossNameRow[c] || '').toLowerCase();
      const dateCell = (labelDateRow[c] || '');
      if (bossCell && bossCell.includes(bossQuery.toLowerCase()) && dateCell.startsWith(today)) {
        candidates.push(c);
      }
    }
    if (candidates.length === 0) {
      await message.reply(`❌ หาคอลัมน์ของ "${bossNameRaw}" วันที่ ${today} ในชีตไม่เจอ — เช็คว่ามีคอลัมน์นี้เตรียมไว้ในชีตแล้วหรือยัง`);
      await message.reactions.removeAll().catch(() => {});
      return;
    }

    let targetCol = candidates[0];
    let timeNote = '';

    if (candidates.length > 1) {
      // บอสตัวนี้เกิดหลายรอบวันเดียวกัน → ใช้เวลาที่พิมพ์กำกับ (ถ้ามี) ไม่งั้นใช้เวลาที่ส่งข้อความ เทียบหาคอลัมน์ที่เวลาใกล้สุด
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
          ? `\n🕐 มีบอสตัวนี้หลายรอบวันนี้ — เลือกรอบ ${best.timePart} ตามเวลาที่พิมพ์กำกับ (${withDiff[0].timePart})`
          : `\n🕐 มีบอสตัวนี้หลายรอบวันนี้ — เลือกรอบ ${best.timePart} ตามเวลาที่ส่งข้อความใกล้สุด`;
      } else {
        const list = withDiff.map(x => `${colToLetter(x.c)} (${x.timePart})`).join(', ');
        await message.reply(`⚠️ พบคอลัมน์ที่ตรงกับ "${bossNameRaw}" วันนี้หลายรอบ และเวลาไม่ชัดเจนพอจะเลือกอัตโนมัติ: ${list}\nลองพิมพ์เวลากำกับให้ชัดเจนกว่านี้ เช่น "${bossQuery} ${withDiff[0].timePart}" หรือกรอกด้วยมือแทน`);
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

client.login(DISCORD_BOT_TOKEN);
