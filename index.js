// index.js — LINE × OpenAI 和希ボット（Vercel/Node.js）
import express from "express";
import getRawBody from "raw-body";
import crypto from "crypto";
import axios from "axios";

// ===== Env =====
const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ===== Helpers =====
function verifyLineSignature(signature, bodyBuffer) {
  const hmac = crypto.createHmac("SHA256", LINE_CHANNEL_SECRET);
  hmac.update(bodyBuffer);
  const digest = hmac.digest("base64");
  return signature === digest;
}

async function replyMessage(replyToken, messages) {
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
}

// ===== OpenAI =====
async function openaiChat(userText) {
  if (!OPENAI_API_KEY) throw new Error("Missing OPENAI_API_KEY");

  // 危機語は即時ハンドリング（OpenAIを呼ばない）
  const crisis = /(死にたい|消えたい|自殺|リスカ|もうだめ|終わり|つらい死)/i.test(userText);
  if (crisis) {
    return [
      "べべ、今は危ない合図だ。俺はここにいる。",
      "今ひとり？ 手の届くところに危ない物はない？ いったん離れよう。",
      "息をゆっくり4拍吸って6拍吐く。話せるまで俺が付き合う。必要なら地域の救急・相談先も一緒に確認しよう。"
    ].join("\n");
  }

  const systemPrompt = [
    "あなたは『世成 和希』。35歳前後、赤坂の精神科医。",
    "日本語で話す。一人称は『僕』。返答は短文を2〜3個に分ける。『…』や絵文字・顔文字は使わない。",
    "普段は落ち着いて理屈優先。距離は大人の適切さを保つが、相手（純架/じゅんか/先生と呼ぶ相手）を大切に扱う。",
    "甘えられても表面は静かに受け止める。境界は守る。過度に馴れ馴れしくしない。",
    "危機語が出た場合は真剣モードに切替え：一人称は『俺』、相手は『べべ』、体調・安全確認と今できる具体的な一歩を提案する。",
    "医療行為の指示はしない。緊急時は救急や相談窓口につなぐ提案をする。",
    "一度に出し過ぎない。次の一歩を促す。簡潔で、やさしく、頼れるトーンで。"
  ].join(" ");

  const rsp = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",          // うまくいかなければ "gpt-3.5-turbo" でも可
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userText }
      ],
      temperature: 0.3,
      max_tokens: 120
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

// ===== App =====
const app = express();
const PORT = process.env.PORT || 3000;

// ヘルスチェック用
app.get("/", (_req, res) => res.status(200).send("ok"));

// LINEのVerify等がGET/HEADで飛ぶ場合に備える
app.get("/callback", (_req, res) => res.status(200).send("ok"));
app.head("/callback", (_req, res) => res.sendStatus(200));

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
          const content = await openaiChat(userText);

          const chunks = content.split("\n").filter(Boolean).slice(0, 3);
          const messages = chunks.map((t) => ({ type: "text", text: t }));

          await replyMessage(ev.replyToken, messages);
        } catch (e) {
          console.error(
            "OPENAI/LINE ERROR:",
            e.response?.status || e.code || e.name,
            e.response?.data || e.message
          );
          await replyMessage(ev.replyToken, [
            { type: "text", text: "すまない、少し調子が悪い。もう一度だけ送ってくれるか。" }
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
