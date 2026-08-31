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
  'venatus': 5, 'viorent': 5, 'ego': 5, 'clemantis': 5, 'livera': 5, 'araneo': 5,
  'undomiel': 5, 'saphirus': 5, 'neutro': 5, 'lady dalia': 5, 'general aqueles': 5,
  'general aquleus': 5, 'thymele': 5, 'amentis': 5, 'baron braudmore': 5, 'milavy': 5,
  'millavy': 5, 'wannitas': 5, 'wannitus': 5, 'metus': 5, 'duplican': 5, 'shuliar': 5,
  'ringor': 5, 'roderick': 5, 'gareth': 5, 'tiyore': 5, 'titore': 5, 'larba': 5,
  'catena': 1.5, 'orgue': 1.5, 'auraq': 1.5, 'secreta': 1.5, 'ordo': 1.5, 'asta': 1.5,
  'supore': 1.5, 'chiflock': 3, 'chaiflock': 3, 'benji': 3, 'libitina': 10,
  'rakejeth': 10, 'lacases': 10, 'icarutier': 10, 'icaruthia': 10, 'motti': 10,
  'kamalia': 5, 'nevaeh': 10, 'tumer': 10, 'tumier': 10, 'lucus': 10,
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
      await message.reply('⚠️ พิมพ์ชื่อบอสในข้อความเดียวกับที่แนบรูป เช่น พิมพ์ "Icarutier" แล้วแนบรูป check-in');
      return;
    }
    const points = getBossPoints(bossNameRaw);
    if (points === null) {
      await message.reply(`❌ ไม่รู้จักคะแนนของบอส "${bossNameRaw}" — เช็คการสะกด หรือเพิ่มบอสนี้ในตาราง BOSS_POINTS ในโค้ดบอทก่อน`);
      return;
    }

    await message.react('⏳');

    // 1) อ่านภาพด้วย AI
    const imgRes = await fetch(image.url);
    const imgBuffer = await imgRes.arrayBuffer();
    const base64 = Buffer.from(imgBuffer).toString('base64');
    const mediaType = image.contentType || 'image/png';
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
            { type: 'text', text: 'ดึงรายชื่อตัวละคร/สมาชิกทั้งหมดที่มองเห็นในภาพนี้ ที่มีสีเทา/จางกว่าปกติให้ข้ามไป (ไม่ได้เข้าร่วม) ตอบเป็น JSON array ของ string เท่านั้น เช่น ["Name1","Name2"] ถ้าไม่พบให้ตอบ []' },
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
    if (textBlock) {
      try { detectedNames = JSON.parse(textBlock.text.replace(/```json|```/g, '').trim()); } catch (e) {}
    }
    if (!detectedNames.length) {
      await message.reply('⚠️ สแกนภาพแล้วไม่พบชื่อเลย กรุณาตรวจสอบภาพหรือกรอกด้วยมือแทน');
      await message.reactions.removeAll().catch(() => {});
      return;
    }

    // 2) อ่านชีตปัจจุบันทั้งหมด (header rows + ข้อมูล)
    const range = `${SHEET_NAME}!A1:ZZ500`;
    const sheetRes = await sheets.spreadsheets.values.get({ spreadsheetId: SPREADSHEET_ID, range });
    const rows = sheetRes.data.values || [];
    const bossNameRow = rows[0] || [];   // แถวชื่อบอส
    const labelDateRow = rows[1] || [];  // แถว No./Member/Score/วันที่

    const memberCol = labelDateRow.findIndex(c => (c || '').trim().toLowerCase() === 'member');
    if (memberCol === -1) {
      await message.reply('❌ หาคอลัมน์ "Member" ในชีตไม่เจอ ตรวจสอบว่า SHEET_NAME ตั้งถูกต้องไหม');
      await message.reactions.removeAll().catch(() => {});
      return;
    }

    // 3) หาคอลัมน์ที่ตรงกับบอส + วันที่วันนี้
    const today = thaiDateToday();
    const candidates = [];
    for (let c = memberCol + 2; c < bossNameRow.length; c++) {
      const bossCell = (bossNameRow[c] || '').toLowerCase();
      const dateCell = (labelDateRow[c] || '');
      if (bossCell.includes(bossNameRaw.toLowerCase()) && dateCell.startsWith(today)) {
        candidates.push(c);
      }
    }
    if (candidates.length === 0) {
      await message.reply(`❌ หาคอลัมน์ของ "${bossNameRaw}" วันที่ ${today} ในชีตไม่เจอ — เช็คว่ามีคอลัมน์นี้เตรียมไว้ในชีตแล้วหรือยัง`);
      await message.reactions.removeAll().catch(() => {});
      return;
    }
    if (candidates.length > 1) {
      await message.reply(`⚠️ พบคอลัมน์ที่ตรงกับ "${bossNameRaw}" วันนี้มากกว่า 1 ช่อง (${candidates.map(c => colToLetter(c)).join(', ')}) — บอทไม่กล้าเดาเอง กรุณากรอกด้วยมือหรือระบุให้ชัดเจนกว่านี้`);
      await message.reactions.removeAll().catch(() => {});
      return;
    }
    const targetCol = candidates[0];

    // 4) จับคู่ชื่อกับแถวสมาชิกในชีต แล้วเตรียมเขียนค่า
    const memberRows = {}; // name(lower) -> row index
    for (let r = 2; r < rows.length; r++) {
      const name = (rows[r][memberCol] || '').trim();
      if (name) memberRows[name.toLowerCase()] = r;
    }

    const updates = [];
    const matched = [];
    const fuzzyMatched = [];
    const unmatched = [];
    detectedNames.forEach(n => {
      const key = n.trim().toLowerCase();
      let rowIdx = memberRows[key];
      let isFuzzy = false;
      let matchedName = n;

      if (rowIdx === undefined) {
        const foundKey = Object.keys(memberRows).find(k => k.includes(key) || key.includes(k));
        if (foundKey) { rowIdx = memberRows[foundKey]; matchedName = foundKey; }
      }

      if (rowIdx === undefined) {
        // ไม่เจอแบบตรง/แบบมีคำซ้อนกัน → ลองจับคู่แบบใกล้เคียง (เข้มงวด)
        let best = null, bestDist = Infinity;
        for (const k of Object.keys(memberRows)) {
          const d = levenshtein(key, k);
          if (d < bestDist) { bestDist = d; best = k; }
        }
        const threshold = key.length <= 4 ? 1 : 2; // ชื่อสั้นยอมพลาดได้แค่ 1 ตัวอักษร ชื่อยาวยอมได้ 2 ตัว
        if (best && bestDist <= threshold) {
          rowIdx = memberRows[best];
          matchedName = best;
          isFuzzy = true;
        }
      }

      if (rowIdx !== undefined) {
        if (isFuzzy) fuzzyMatched.push(`${n} → ${matchedName}`);
        else matched.push(n);
        const a1 = `${SHEET_NAME}!${colToLetter(targetCol)}${rowIdx + 1}`;
        updates.push({ range: a1, values: [[points]] });
      } else {
        unmatched.push(n);
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
    await message.reply(
      `✅ กรอกคะแนนแล้ว — **${bossNameRaw}** (${points} pt) คอลัมน์ ${colToLetter(targetCol)} วันที่ ${today}\n` +
      `บันทึกตรงชื่อ (${matched.length}): ${matched.join(', ')}${noteFuzzy}${noteUnmatched}`
    );
  } catch (err) {
    console.error(err);
    try { await message.reply('❌ เกิดข้อผิดพลาด: ' + err.message); } catch (e) {}
  }
});

client.login(DISCORD_BOT_TOKEN);
