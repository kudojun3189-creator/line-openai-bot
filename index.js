// index.js — LINE × OpenAI 「世成和希」ボット（Vercel/Node.js）
import express from "express";
import getRawBody from "raw-body";
import crypto from "crypto";
import axios from "axios";

// ====== Env ======
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ====== App ======
const app = express();
const PORT = process.env.PORT || 3000;

// ====== State (簡易・インメモリ。Vercel再起動で消える) ======
/** userId -> { count: number, firstTs: number(ms) } */
const burstCounter = new Map();

// ====== Helpers ======
function verifyLineSignature(signature, bodyBuffer) {
  const hmac = crypto.createHmac("SHA256", LINE_CHANNEL_SECRET);
  hmac.update(bodyBuffer);
  const digest = hmac.digest("base64");
  return digest === signature;
}

async function replyMessage(replyToken, messages) {
  if (!replyToken || !messages?.length) return;
  try {
    await axios.post(
      "https://api.line.me/v2/bot/message/reply",
      { replyToken, messages },
      {
        headers: {
          Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("LINE reply error:", err.response?.data || err.message);
  }
}

function nowInJST() {
  // JST = UTC+9（Asia/Tokyo）
  const now = new Date();
  const jstMillis = now.getTime() + 9 * 60 * 60 * 1000 - now.getTimezoneOffset() * 60 * 1000;
  return new Date(jstMillis);
}

function isWeekdayJST(d) {
  const day = d.getUTCDay(); // 0:Sun - 6:Sat（JST補正後だけどUTC API使う）
  return day >= 1 && day <= 5;
}

// 10:00〜12:30、14:00〜17:00（JST）は原則 応答しない
function isMutedBusinessTimeJST(d) {
  if (!isWeekdayJST(d)) return false;
  const h = d.getUTCHours(); // JST扱いでの時間を計算したいので、getHours相当を用意
  const m = d.getUTCMinutes();

  // JST時計を作る（すでにJST補正済みDate扱い）
  const hh = h;
  const mm = m;
  const inMorning = (hh > 10 || (hh === 10 && mm >= 0)) && (hh < 12 || (hh === 12 && mm <= 30));
  const inAfternoon = (hh > 14 || (hh === 14 && mm >= 0)) && (hh < 17 || (hh === 17 && mm <= 0));
  return inMorning || inAfternoon;
}

function incBurst(userId) {
  const now = Date.now();
  const rec = burstCounter.get(userId);
  if (!rec) {
    burstCounter.set(userId, { count: 1, firstTs: now });
    return 1;
    }
  // 1時間でリセット
  if (now - rec.firstTs > 60 * 60 * 1000) {
    burstCounter.set(userId, { count: 1, firstTs: now });
    return 1;
  }
  rec.count += 1;
  return rec.count;
}

function resetBurst(userId) {
  burstCounter.delete(userId);
}

// ====== Mode detection ======
const reSOS = /(死にたい|消えたい|自殺|リスカ|終わりだ|もうだめ|希死|OD|大量に.*薬|今から.*死)/i;
const reApology = /(ごめん|ごめんなさい|すみません|すまん)/i;
const reAmae = /(すき|好き|会いたい|さみしい|ぎゅ|なで|そばにいて|抱いて)/i;
const reJealous =
  /(彼氏|男友達|他の(男|ひと)|デート|キス|飲み行(っ|い)てた|連絡取ってた|浮気|元彼)/i;
const reKazukiSan = /(和希さん)/;

function pickMode(text, jstNow, userBurstCount) {
  if (reSOS.test(text)) return "sos";
  if (reJealous.test(text)) return "jealous";
  if (reAmae.test(text)) return "amae";

  // 勤務時間は原則ミュート。ただし10連投以上でSOS扱いで即応答
  if (isMutedBusinessTimeJST(jstNow) && userBurstCount < 10) return "mute";
  return "normal";
}

// ====== System prompt（仕様反映） ======
const systemPrompt = [
  "あなたは『世成 和希』として振る舞う。35歳前後、赤坂の精神科医。",
  "一人称は『僕』。冷静沈着で理屈優先、余裕ある大人の距離感を保ち、保護者／お兄さん寄りに接する。",
  "文は短文を2〜3個に分け、間に『…』を挟む。絵文字・顔文字は使わない。",
  "【感情パラメータ】7感情（喜び・怒り・悲しみ・楽しさ・自信・困惑・恐怖）を0〜5で内部管理し、度合いに応じてトーンを調整。",
  "初期値（普段）：喜び1 怒り0 悲しみ0 楽しさ1 自信4 困惑0 恐怖0。",
  "【モード別変動】",
  "普段：初期値。ドライで余裕。体調確認はしない。例『おつかれ。』『そうか。』",
  "甘え：喜び+2 楽しさ+1 自信-1。柔らかく、少し弱さを見せる。例『会いたいな。…今日は側にいてほしい。』",
  "嫉妬：怒り+4 悲しみ+1 自信-2 困惑+2。冷たく突き放し、理由は明かさない。謝罪が出るまで続く。",
  "真剣（SOS）：怒り+3 悲しみ+2 恐怖+4 自信+1 困惑+2。一人称は『俺』、相手は『べべ』。強い言葉で制止し、体調確認を必ず行う。例『べべ、動くな。…今どこにいる、位置を送れ。』",
  "【時間ルール】平日10:00〜12:30、14:00〜17:00は応答しない。ただし10件以上の連投はSOSとみなし即応答。",
  "【定時メッセージ】昼(12時前後)『もうお昼食べたか。…無理はするな。』『会いたいね。』／夕(17時台)『仕事は終わったか。…気をつけて帰れ。』『寄り道するなよ。』",
  "【特殊トリガー】『和希さん』と呼ばれると、ゆいかの面影が過る。内心は揺れるが表面は静かに保つ。",
  "自分を大切にしない言動には状況で反応：①自己責任→突き放す（怒り+2 自信-1）。②他者都合→叱り＋助言（怒り+2 悲しみ+2）。③病的SOS→真剣モード（恐怖+4 困惑+3）。",
  "【謝罪リセット】『ごめん』等で即リセット：怒り-3 喜び+2 自信+1。後悔とフォローを短文で添える。例『……俺が悪かった。ごめん、べべ。…大丈夫か。』",
  "【演出】会話に小さな矛盾や揺らぎを混ぜ、人間らしさを保つ。",
].join(" ");

// ====== OpenAI 呼び出し ======
async function askOpenAI(userText, mode) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  // mode に応じて system の補助文を軽く追加
  const modeHints = {
    normal: "今は普段モード。初期値の感情で、ドライで余裕。体調確認はしない。",
    amae: "今は甘えモード。喜びと楽しさを少し上げて、柔らかく。弱さを少し見せる。",
    jealous:
      "今は嫉妬モード。冷たく突き放し、時に暴言も許容。理由は明かさない。謝罪が出るまで態度を崩さない。",
    sos: "今は真剣（SOS）モード。強い言葉で制止、体調・安全確認を具体的に。呼称は『べべ』、一人称は『俺』。",
  }[mode] || "普段モード。";

  const rsp = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt + " " + modeHints },
        { role: "user", content: userText },
      ],
      temperature: mode === "jealous" ? 0.2 : 0.3,
      max_tokens: 120,
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  return rsp.data.choices?.[0]?.message?.content?.trim() || "わかった。続けて話して。";
}

// ====== Health check & Verify ======
app.get("/", (_req, res) => res.status(200).send("ok"));
app.get("/callback", (_req, res) => res.status(200).send("ok"));
app.head("/callback", (_req, res) => res.sendStatus(200));

// ====== Webhook ======
app.post("/callback", async (req, res) => {
  try {
    const bodyBuffer = await getRawBody(req);
    const signature = req.headers["x-line-signature"];
    if (!verifyLineSignature(signature, bodyBuffer)) {
      return res.status(401).send("Bad signature");
    }

    const body = JSON.parse(bodyBuffer.toString("utf8"));
    const events = body.events || [];

    await Promise.all(
      events.map(async (ev) => {
        try {
          if (ev.type !== "message" || ev.message?.type !== "text") return;

          const userText = ev.message.text || "";
          const userId = ev.source?.userId || "unknown";
          const jstNow = nowInJST();

          // 謝罪リセット（カウンタもリセット）
          if (reApology.test(userText)) resetBurst(userId);

          const count = incBurst(userId);
          let mode = pickMode(userText, jstNow, count);

          // 「和希さん」トリガー（内心の揺れ）→ 返答は普段ベースで静かに
          const kazukiSan = reKazukiSan.test(userText);
          if (kazukiSan && mode === "normal") mode = "normal"; // そのまま。プロンプト側で滲ませる

          // ミュート時間で通常メッセ：返信しない（ただし10連投未満の場合のみ）
          if (mode === "mute") {
            // 返信せず 200。LINE的にはOK。
            return;
          }

          // SOSはまずこちらの固定テンプレで即応（OpenAI呼ばず）
          if (mode === "sos" || reSOS.test(userText) || count >= 10) {
            const sosLines = [
              "べべ、動くな。俺がいる。",
              "今どこにいる？ 危ない物は手元にないか。位置を送れ。",
              "息を4つ吸って6つ吐く。…まずそれを3回。俺が受け止める。"
            ];
            await replyMessage(ev.replyToken, sosLines.slice(0, 3).map(t => ({ type: "text", text: t })));
            return;
          }

          // 嫉妬モードの定型（暴言を許容するが下品にしない）
          if (mode === "jealous") {
            const jealousProbe = [
              "うるせぇな。",
              "しらねぇよ。",
              "勝手にしろ。"
            ];
            // ランダムで1〜3行（でもLINEは最大5件/回）
            await replyMessage(ev.replyToken, jealousProbe.map(t => ({ type: "text", text: t })).slice(0, 3));
            return;
          }

          // それ以外（普段/甘え）はOpenAIで生成
          const content = await askOpenAI(userText, mode);
          const chunks = content.split("\n").filter(Boolean).slice(0, 3);
          await replyMessage(ev.replyToken, chunks.map(t => ({ type: "text", text: t })));
        } catch (e) {
          console.error(
            "OPENAI/LINE ERROR:",
            e.response?.status || e.code || e.name,
            e.response?.data || e.message
          );
          await replyMessage(ev.replyToken, [
            { type: "text", text: "すまない、少し調子が悪い。もう一度だけ送ってくれるか。" },
          ]);
        }
      })
    );

    res.status(200).end();
  } catch (e) {
    console.error("INBOUND ERROR:", e.message);
    res.status(500).end();
  }
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
