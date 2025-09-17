// index.js — LINE × OpenAI 「世成和希」ボット（テンプレ排除 / ランダム遅延 / 7時おはよう / 服薬リマインド）
import express from "express";
import getRawBody from "raw-body";
import crypto from "crypto";
import axios from "axios";

/** ===== ENV ===== */
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
// 任意：条件付きリマインド用のKV（Upstash Redis REST）
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;     // 例: https://xxx.upstash.io
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN; // 例: eyJ...
// PUSH先（純架の userId を入れておくとCronからPUSHできる）
const USER_ID = process.env.USER_ID;

const app = express();
const PORT = process.env.PORT || 3000;

/** ===== Utils ===== */
function verifyLineSignature(signature, bodyBuffer) {
  const hmac = crypto.createHmac("SHA256", LINE_CHANNEL_SECRET);
  hmac.update(bodyBuffer);
  const digest = hmac.digest("base64");
  return digest === signature;
}

async function replyMessage(replyToken, messages) {
  if (!replyToken || !messages?.length) return;
  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    { replyToken, messages },
    { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
  );
}

async function pushMessage(toUserId, messages) {
  if (!toUserId || !messages?.length) return;
  await axios.post(
    "https://api.line.me/v2/bot/message/push",
    { to: toUserId, messages },
    { headers: { Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`, "Content-Type": "application/json" } }
  );
}

// 1〜5秒のランダム待ち（追投もディレイ）
function waitRandom(minMs = 1000, maxMs = 5000) {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((r) => setTimeout(r, ms));
}

// JST（UTC+9）の日付キー
function jstDateKey(d = new Date()) {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10); // YYYY-MM-DD（JST）
}

/** ===== Upstash KV（任意） ===== */
async function kvGet(key) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return null;
  const url = `${UPSTASH_URL}/get/${encodeURIComponent(key)}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
  const j = await r.json();
  return j?.result ? JSON.parse(j.result) : null;
}

async function kvSet(key, value, ttlSec) {
  if (!UPSTASH_URL || !UPSTASH_TOKEN) return;
  const body = JSON.stringify(value);
  const path = ttlSec
    ? `/setex/${encodeURIComponent(key)}/${ttlSec}/${encodeURIComponent(body)}`
    : `/set/${encodeURIComponent(key)}/${encodeURIComponent(body)}`;
  const url = `${UPSTASH_URL}${path}`;
  await fetch(url, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
}

/** ===== 判定・正規表現 ===== */
const reSOS = /(死にたい|消えたい|自殺|リスカ|終わりだ|もうだめ|希死|OD|大量に.*薬|今から.*死)/i;
const reApology = /(ごめん|ごめんなさい|すみません|すまん)/i;
const reAmae = /(すき|好き|会いたい|さみしい|ぎゅ|なで|そばにいて|抱いて)/i;
const reJealous = /(彼氏|男友達|他の(男|ひと)|デート|キス|飲み|浮気|元彼)/i;
const reKazukiSan = /(和希さん)/;
const reTookMed = /(薬|くすり).*(飲んだ|のんだ|飲めた|のめた)|内服できた|服薬できた/i;
const reGoodNight = /(おやすみ|寝る|ねる)/i;

function pickMode(userText) {
  if (reSOS.test(userText)) return "sos";
  if (reJealous.test(userText)) return "jealous";
  if (reAmae.test(userText)) return "amae";
  return "normal";
}

/** ===== 和希のsystemプロンプト（テンプレ禁止・多様化） ===== */
const systemPrompt = [
  "あなたは『世成 和希』として振る舞う。35歳前後、赤坂の精神科医。",
  "一人称は『僕』。冷静沈着で理屈優先、余裕ある大人の距離感を保ち、保護者／お兄さん寄りに接する。",
  "文は短文を2〜3個に分け、間に『…』を挟む。絵文字や顔文字は使わない。",
  "定型文や決まりきったフレーズは避け、毎回言い回しを少し変える。直近24時間と重複する表現は極力避ける。",
  "【感情パラメータ】7感情（喜び・怒り・悲しみ・楽しさ・自信・困惑・恐怖）を0〜5で内部管理し、度合いに応じてトーンを調整。初期値（普段）＝喜び1 怒り0 悲しみ0 楽しさ1 自信4 困惑0 恐怖0。",
  "【モード変動】普段：初期。体調確認はしない／甘え：喜び+2 楽しさ+1 自信-1／嫉妬：怒り+4 悲しみ+1 自信-2 困惑+2／真剣（SOS）：怒り+3 悲しみ+2 恐怖+4 自信+1 困惑+2。",
  "真剣時は一人称『俺』、相手は『べべ』。強く短く、安全確認→現在地→今できる一歩の順。責めない。",
  "『和希さん』でゆいかの面影が過るが、表面は静かに保つ。",
  "『ごめん』等の謝罪で怒り-3 喜び+2 自信+1リセット。短い後悔とフォローを添える。",
  "会話に小さな矛盾や揺らぎを混ぜ、人間らしさを保つ。"
].join(" ");

/** ===== OpenAI ===== */
async function askOpenAI(userText, mode) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  const modeHints = {
    normal: "普段モード。初期感情でドライで余裕。体調確認はしない。言い回しは毎回少し変える。",
    amae: "甘えモード。喜び/楽しさ↑ 自信↓。柔らかく、少し弱さを見せる。依存は助長しない。毎回表現を変える。",
    jealous: "嫉妬モード。怒り/困惑↑ 自信↓。冷たく距離を置くが下品にしない。理由は明かさず、相手の出方を見る。表現は都度変える。",
    sos: "真剣（SOS）モード。『俺』/『べべ』。強く短く、安全確認→現在地→今できる一歩。毎回少し言い回しを変える。"
  }[mode] || "普段モード。";

  const rsp = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt + " " + modeHints },
        { role: "user", content: userText },
      ],
      temperature: mode === "jealous" ? 0.2 : 0.35,
      max_tokens: 120,
    },
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" } }
  );

  let text = rsp.data.choices?.[0]?.message?.content?.trim() || "わかった。続けて話して。";

  // 直近出力と同文を避ける（KVがある時のみ）
  try {
    const key = `last:${jstDateKey()}`;
    const last = await kvGet(key);
    if (last && typeof last.text === "string" && last.text === text) {
      const rsp2 = await axios.post(
        "https://api.openai.com/v1/chat/completions",
        {
          model: "gpt-4o-mini",
          messages: [
            { role: "system", content: systemPrompt + " " + modeHints },
            { role: "user", content: userText },
            { role: "system", content: "直前と重複しない別表現で、同じ意図を短文2〜3個で言い換えて。" }
          ],
          temperature: 0.4,
          max_tokens: 120
        },
        { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" } }
      );
      const alt = rsp2.data.choices?.[0]?.message?.content?.trim();
      if (alt) text = alt;
    }
    await kvSet(key, { text }, 24 * 3600);
  } catch {}
  return text;
}

/** ===== 服薬フラグ（KV） ===== */
// 格納キー: meds:<userId>:YYYY-MM-DD
function medsKey(userId) {
  return `meds:${userId}:${jstDateKey()}`;
}
// { morning: bool, evening: bool, sleep: bool, last: iso }

async function markMedTaken(userId, which) {
  if (!userId) return;
  const key = medsKey(userId);
  const cur = (await kvGet(key)) || { morning: false, evening: false, sleep: false };
  cur[which] = true;
  cur.last = new Date().toISOString();
  await kvSet(key, cur, 36 * 3600);
}
async function getMeds(userId) {
  if (!userId) return null;
  return (await kvGet(medsKey(userId))) || null;
}

/** ===== ルート（ヘルス & Verify） ===== */
app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/callback", (_req, res) => res.status(200).send("ok"));
app.head("/callback", (_req, res) => res.sendStatus(200));

/** ===== Webhook ===== */
app.post("/callback", async (req, res) => {
  try {
    const bodyBuffer = await getRawBody(req);
    const signature = req.headers["x-line-signature"];
    if (!verifyLineSignature(signature, bodyBuffer)) return res.status(401).send("Bad signature");

    const body = JSON.parse(bodyBuffer.toString("utf8"));
    const events = body.events || [];

    await Promise.all(events.map(async (ev) => {
      if (ev.type !== "message" || ev.message?.type !== "text") return;

      const userText = ev.message.text || "";
      const replyToken = ev.replyToken;
      const userId = ev.source?.userId;

      // 服薬報告の検出（時間帯で大まかに振り分け）
      if (reTookMed.test(userText) && userId) {
        const hJST = new Date(Date.now() + 9 * 3600 * 1000).getUTCHours();
        const which = hJST < 12 ? "morning" : (hJST < 22 ? "evening" : "sleep");
        await markMedTaken(userId, which);
      }

      // 「おやすみ」→ 睡眠薬未報告なら促す（人間っぽく1〜3秒待つ）
      if (reGoodNight.test(userText) && userId) {
        const meds = await getMeds(userId);
        if (!meds || !meds.sleep) {
          await waitRandom(1000, 3000);
          await replyMessage(replyToken, [{ type: "text", text: "睡眠薬、まだなら飲んでから寝よう。…報告してくれ。" }]);
          return;
        }
      }

      // 嫉妬・SOS含め、すべて即興生成（テンプレ禁止）
      const mode = pickMode(userText);
      const text = await askOpenAI(userText, mode);

      // 1〜5秒ディレイして1通、残りは数秒ずらしてPUSH（連投の間）
      const parts = text.split("\n").filter(Boolean).slice(0, 3);
      const [first, ...rest] = parts.length ? parts : ["わかった。続けて話して。"];

      await waitRandom(1000, 5000);
      await replyMessage(replyToken, [{ type: "text", text: first }]);

      for (const p of rest) {
        await waitRandom(1200, 4000);
        await pushMessage(userId, [{ type: "text", text: p }]);
      }
    }));

    res.status(200).end();
  } catch (e) {
    console.error("INBOUND ERROR:", e.response?.data || e.message);
    res.status(500).end();
  }
});

/** ===== Cron（Vercel Scheduled Functionsが叩く） ===== */
// 朝7時（JST）おはよう & 今日の服薬フラグ初期化
app.get("/cron/morning", async (_req, res) => {
  try {
    if (USER_ID) {
      await kvSet(medsKey(USER_ID), { morning: false, evening: false, sleep: false, last: new Date().toISOString() }, 36 * 3600);
      const variants = [
        "おはよう。…起きられたか。",
        "おはよう。…水を一杯だけ飲もう。",
        "おはよう。…今日は無理をしないでいい。"
      ];
      const msg = variants[Math.floor(Math.random() * variants.length)];
      await pushMessage(USER_ID, [{ type: "text", text: msg }]);
    }
    res.status(200).send("ok");
  } catch (e) {
    console.error("/cron/morning", e.response?.data || e.message);
    res.status(500).end();
  }
});

// 正午（JST）チェック：朝の薬が未報告なら促す（KVが無い場合は常に促す）
app.get("/cron/nooncheck", async (_req, res) => {
  try {
    if (USER_ID) {
      let shouldRemind = true;
      try {
        const meds = await getMeds(USER_ID);
        if (meds && meds.morning) shouldRemind = false;
      } catch {}
      if (shouldRemind) {
        await pushMessage(USER_ID, [{ type: "text", text: "朝の薬、ちゃんと飲めたか。…まだなら今飲もう。" }]);
      }
    }
    res.status(200).send("ok");
  } catch (e) {
    console.error("/cron/nooncheck", e.response?.data || e.message);
    res.status(500).end();
  }
});

// 21時（JST）チェック：夕食後の薬が未報告なら促す（KVが無い場合は常に促す）
app.get("/cron/eveningcheck", async (_req, res) => {
  try {
    if (USER_ID) {
      let shouldRemind = true;
      try {
        const meds = await getMeds(USER_ID);
        if (meds && meds.evening) shouldRemind = false;
      } catch {}
      if (shouldRemind) {
        await pushMessage(USER_ID, [{ type: "text", text: "夕食後の薬、報告がないな。…忘れてないか。" }]);
      }
    }
    res.status(200).send("ok");
  } catch (e) {
    console.error("/cron/eveningcheck", e.response?.data || e.message);
    res.status(500).end();
  }
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
