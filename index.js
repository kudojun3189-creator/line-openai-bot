import express from "express";
import getRawBody from "raw-body";
import crypto from "crypto";
import axios from "axios";

const app = express();
const PORT = process.env.PORT || 3000;

const LINE_CHANNEL_SECRET = process.env.LINE_CHANNEL_SECRET;
const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// --- LINE署名の検証 ---
function verifyLineSignature(signature, body) {
  const hash = crypto
    .createHmac("SHA256", LINE_CHANNEL_SECRET)
    .update(body)
    .digest("base64");
  return hash === signature;
}

// --- LINEに返信 ---
async function replyMessage(replyToken, messages) {
  try {
    await axios.post(
      "https://api.line.me/v2/bot/message/reply",
      {
        replyToken,
        messages,
      },
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

// --- OpenAI呼び出し ---
async function openaiChat(userText) {
  const resp = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-3.5-turbo",
      messages: [{ role: "user", content: userText }],
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );
  return resp.data.choices[0].message.content;
}

// --- ここからアプリ設定 ---
app.get("/callback", (_req, res) => res.status(200).send("ok"));
app.head("/callback", (_req, res) => res.sendStatus(200));

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
          { type: "text", text: "すまない、少し調子が悪い。もう一度だけ送ってくれるか。" },
        ]);
      }
    })
  ).then(() => res.status(200).end());
});

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
