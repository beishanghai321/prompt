/**
 * /api/map-ctrl —— 用 DeepSeek 把「中控配合」的每条动作指派到具体那一句台词
 *
 * 安全设计（key 永不出服务端）：
 *  - key 只从 env.DEEPSEEK_API_KEY 读取，前端拿不到、仓库里没有
 *  - 只接受同源请求（Origin/Referer 校验）
 *  - 简单限流（同一实例内存计数，可选接 KV 做全局）
 *  - 输入字段白名单 + 长度上限，拒绝任意大 payload
 *  - 出错只回通用信息，不透出上游细节
 *  - 响应 no-store，绝不缓存
 *
 * 请求：POST /api/map-ctrl
 *   { blocks: [ { name, cues: ["台词1","台词2",...], ctrl: ["动作1","动作2",...] } ] }
 * 返回：
 *   { ok: true, blocks: [ { assign: [{ ctrl: 0, cue: 2 }, ...] } ] }
 */
const MAX_BLOCKS = 12;
const MAX_CUES = 200;
const MAX_CTRL = 30;
const MAX_LEN = 120;
const RATE = { windowMs: 60_000, max: 20 };   // 每个实例每分钟最多 20 次

const hits = new Map();

export async function onRequestOptions({ request }) {
  const origin = request.headers.get("Origin") || "";
  return new Response(null, { status: 204, headers: corsHeaders(origin, request) });
}

export async function onRequestGet({ env }) {
  // 只回一个布尔值：方便你在浏览器里确认密钥是否已生效，不暴露任何内容
  return json({ ok: true, endpoint: "/api/map-ctrl", keyConfigured: !!(env && env.DEEPSEEK_API_KEY) },
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

  const blocks = sanitize(body && body.blocks);
  if (!blocks.length) return json({ ok: false, error: "no blocks" }, 400);

  const sys = [
    "你是直播中控的动作调度器。",
    "输入：某板块的台词列表（cues，按顺序，主语是主播）与若干条中控动作（ctrl）。",
    "任务：为每条中控动作选择它应当触发的台词下标 cue（从 0 开始）；若属于全场通用（如倒计时贴片常驻），用 -1。",
    "判定依据：动作里提到的文案、编号、数字、名词，与该句台词的语义是否对应；按先后顺序通常对应最先提到它的那句。",
    "只输出 JSON：{\"assign\":[{\"ctrl\":动作下标,\"cue\":台词下标}]}，不要任何解释。"
  ].join("\n");

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12000);

  try {
    const resp = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      signal: ac.signal,
      body: JSON.stringify({
        model: "deepseek-chat",
        temperature: 0,
        max_tokens: 1200,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: sys },
          { role: "user", content: JSON.stringify(blocks) }
        ]
      })
    });
    clearTimeout(timer);

    if (!resp.ok) return json({ ok: false, error: "upstream" }, 502);

    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content || "{}";
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }

    const assign = Array.isArray(parsed.assign) ? parsed.assign : [];
    const out = assign
      .map(a => ({ ctrl: Number(a.ctrl), cue: Number(a.cue) }))
      .filter(a => Number.isInteger(a.ctrl) && Number.isInteger(a.cue));

    return json({ ok: true, blocks: blocks.map(() => ({ assign: out })) }, 200, {
      "Cache-Control": "no-store"
    });
  } catch (e) {
    clearTimeout(timer);
    return json({ ok: false, error: "timeout" }, 504);
  }
}

/* ---------- 辅助 ---------- */
function sameOrigin(origin, request) {
  if (!origin) return true;                     // 同源导航可能没有 Origin
  try {
    const o = new URL(origin);
    const h = new URL(request.url);
    return o.host === h.host;
  } catch { return false; }
}

function rateOk(ip) {
  const now = Date.now();
  const rec = hits.get(ip);
  if (!rec || now - rec.start > RATE.windowMs) { hits.set(ip, { start: now, n: 1 }); return true; }
  rec.n++;
  return rec.n <= RATE.max;
}

function clip(s, n = MAX_LEN) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n);
}

function sanitize(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks.slice(0, MAX_BLOCKS).map(b => ({
    name: clip(b && b.name, 40),
    cues: (Array.isArray(b && b.cues) ? b.cues : []).slice(0, MAX_CUES).map(c => clip(c)),
    ctrl: (Array.isArray(b && b.ctrl) ? b.ctrl : []).slice(0, MAX_CTRL).map(c => clip(c, 80))
  })).filter(b => b.cues.length && b.ctrl.length);
}

function corsHeaders(origin, request) {
  const ok = sameOrigin(origin, request);
  return ok
    ? { "Access-Control-Allow-Origin": origin || "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", Vary: "Origin" }
    : {};
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra }
  });
}
