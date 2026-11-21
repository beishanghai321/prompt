/**
 * /api/title —— 用 DeepSeek 给脚本生成一个合适的标题
 *
 * 解决：脚本第一行常是「11月22直播脚本（终稿）」这类文件名式标题，
 * 不适合当提词页标题。由 AI 读开头几句，给出 8—14 字的场景化标题。
 *
 * 请求：POST /api/title  { head: ["台词1", ...], hint: "原文件名或首行" }
 * 返回：{ ok: true, title: "小雪冬藏 · 复播第一讲" }
 */
const MAX_HEAD = 20;
const MAX_LEN = 80;
const RATE = { windowMs: 60_000, max: 15 };
const hits = new Map();

export async function onRequestGet({ env }) {
  return json({ ok: true, endpoint: "/api/title", keyConfigured: !!(env && env.DEEPSEEK_API_KEY) },
              200, { "Cache-Control": "no-store" });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get("Origin") || request.headers.get("Referer") || "";
  if (!sameOrigin(origin, request)) return json({ ok: false, error: "forbidden" }, 403);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!rateOk(ip)) return json({ ok: false, error: "too many requests" }, 429);

  const key = env.DEEPSEEK_API_KEY;
  if (!key) return json({ ok: false, error: "not configured" }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }

  const head = (Array.isArray(body && body.head) ? body.head : [])
    .slice(0, MAX_HEAD).map(s => String(s || "").replace(/\s+/g, " ").trim().slice(0, MAX_LEN)).filter(Boolean);
  if (!head.length) return json({ ok: false, error: "no head" }, 400);
  const hint = String((body && body.hint) || "").slice(0, 60);

  const sys = [
    "你给直播脚本起标题。",
    "输入：脚本开头的若干句台词（可能含主播口播、节气、产品名），以及原文件名。",
    "要求：中文，8—14 个字，说明这场直播的主题（可含节气/主题/场次），不要书名号、不要「脚本」「终稿」「第一期」这类词，不要日期。",
    "只输出 JSON：{\"title\":\"...\"}"
  ].join("\n");

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);

  try {
    const resp = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      signal: ac.signal,
      body: JSON.stringify({
        model: "deepseek-chat",
        temperature: 0.3,
        max_tokens: 60,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: sys },
          { role: "user", content: JSON.stringify({ hint, head }) }
        ]
      })
    });
    clearTimeout(timer);
    if (!resp.ok) return json({ ok: false, error: "upstream" }, 502);

    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content || "{}";
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }
    const title = String(parsed.title || "").replace(/[《》「」【】"]/g, "").trim().slice(0, 20);
    if (!title) return json({ ok: false, error: "empty" }, 502);
    return json({ ok: true, title }, 200, { "Cache-Control": "no-store" });
  } catch (e) {
    clearTimeout(timer);
    return json({ ok: false, error: "timeout" }, 504);
  }
}

function sameOrigin(origin, request) {
  if (!origin) return true;
  try { return new URL(origin).host === new URL(request.url).host; } catch { return false; }
}
function rateOk(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > RATE.windowMs) { hits.set(ip, { start: now, n: 1 }); return true; }
  rec.n++;
  return rec.n <= RATE.max;
}
function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra }
  });
}
