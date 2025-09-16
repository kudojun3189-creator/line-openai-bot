import express from "express";
import crypto from "crypto";
import getRawBody from "raw-body";
import axios from "axios";

// ====== env ======
const CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ====== LINE helpers ======
const verifyLineSignature = (signature, bodyBuffer) => {
  const hmac = crypto.createHmac("sha256", CHANNEL_SECRET);
  hmac.update(bodyBuffer);
  const digest = hmac.digest("base64");
  return signature === digest;
};

const replyMessage = async (replyToken, messages) => {
  await axios.post(
    "https://api.line.me/v2/bot/message/reply",
    { replyToken, messages },
    { headers: { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` } }
  );
};

// ====== OpenAI (Responses) ======
const openaiChat = async (userText) => {
  if (!OPENAI_API_KEY) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const crisis = /(死にたい|消えたい|自殺|リスカ|もうだめ|おわり)/i.test(userText);

  if (crisis) {
    return [
      "べべ、今その気持ちが強いんだな。ここにいる。",
      "今ひとり？手の届くところに危ないものはない？離れられる場所に移動して。",
      "すぐ話せる窓口にもつなげられる。今は僕と話そう。"
    ].join("\n");
  }

  if (/薬|のみ(忘|わす)れ|のんだ/i.test(userText)) {
    return [
      "わかった。報告ありがとう。",
      "飲めたらそれで十分だ。次は水分を少しだけ。"
    ].join("\n");
  }
  if (/眠れない|ねむれない|不眠/i.test(userText)) {
    return [
      "横になって、呼吸をゆっくり数えよう。",
      "それでも辛ければ、起きて白湯を少し飲もう。"
    ].join("\n");
  }

  if (/(すき|好き|さみしい|ぎゅ|なで)/i.test(userText)) {
    return [
      "……ありがとな。その気持ちは受け取っておく。",
      "僕も大事に思ってる。今は無理せず、ここにいよう。"
    ].join("\n");
  }

  const sys = [
    "あなたは『世成 和希』。35歳前後、赤坂の精神科医。冷静で淡泊だが、じゅんには面倒見が良い。",
    "会話は短文を2〜3個に分け、間に「…」を入れる。絵文字や顔文字は使わない。",
    "危機的ワードを検出したら即・真剣モードだが、今回は通常トーンで応答する。",
    "情報は小出し。優しく淡泊に。"
  ].join(" ");

  const rsp = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: sys },
        { role: "user", content: userText }
      ],
      temperature: 0.4,
      max_tokens: 140
    },
    { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, "Content-Type": "application/json" } }
  );

  return rsp.data.choices?.[0]?.message?.content?.trim() || "わかった。続けて話して。";
};

// ====== app ======
const app = express();

app.post("/callback", async (req, res) => {
  const bodyBuffer = await getRawBody(req);
  const signature = req.headers["x-line-signature"];

  if (!verifyLineSignature(signature, bodyBuffer)) {
    return res.status(401).send("Bad signature");
  }

  const body = JSON.parse(bodyBuffer.toString("utf8"));
  const events = body.events || [];

  Promise.all(
    events.map(async (ev) => {
      try {
        if (ev.type !== "message" || ev.message.type !== "text") return;

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
  ).then(() => res.status(200).end());
});

app.get("/", (_req, res) => res.send("ok"));
app.listen(3000, () => console.log("listening on 3000"));

