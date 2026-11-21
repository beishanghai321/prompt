import { aiGuard } from "./session.js";
/**
 * /api/split —— 用 DeepSeek 把一份"没有板块标题"的脚本，按内容切成若干板块
 *
 * 适用：脚本只有【说话人】+ 段落，没有「环节1：xxx（0—4分钟）」或时间轴标题。
 * 规则解析后只有 1 个"整场"板块时，交给这个接口做一次分段。
 *
 * 请求：POST /api/split
 *   { totalMinutes: 45, cues: [{ sp, t }, ...] }     // cues 已按顺序，最多 300 条
 * 返回：
 *   { ok: true, blocks: [ { name, from, to, minutes } ] }   // from/to 为 cue 下标（含）
 *
 * 安全：key 只在服务端；同源校验；限流；输入裁剪；错误不外泄；no-store
 */
const MAX_CUES = 300;
const MAX_LEN = 120;
const RATE = { windowMs: 60_000, max: 10 };
const hits = new Map();

export async function onRequestGet({ env }) {
  return json({ ok: true, endpoint: "/api/split", keyConfigured: !!(env && env.DEEPSEEK_API_KEY) },
              200, { "Cache-Control": "no-store" });
}

export async function onRequestPost({ request, env }) {
  const gate = await aiGuard(request, env);
  if (gate.deny) return gate.deny;
  const gateCookie = gate.cookie ? { "Set-Cookie": gate.cookie } : {};
  const origin = request.headers.get("Origin") || request.headers.get("Referer") || "";
  if (!sameOrigin(origin, request)) return json({ ok: false, error: "forbidden" }, 403);

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  if (!rateOk(ip)) return json({ ok: false, error: "too many requests" }, 429);

  const key = env.DEEPSEEK_API_KEY;
  if (!key) return json({ ok: false, error: "not configured" }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ ok: false, error: "bad json" }, 400); }

  const cues = sanitizeCues(body && body.cues);
  if (cues.length < 4) return json({ ok: false, error: "too few cues" }, 400);
  const total = Math.max(5, Math.min(180, Number(body && body.totalMinutes) || 45));

  const sys = [
    "你是直播脚本的段落规划器。",
    "输入：一条直播的完整台词列表（cues，已按顺序，含说话人），总时长约 N 分钟。",
    "任务：把台词切成 4—8 个板块，模拟真实直播节奏：开场暖场 → 痛点/铺垫 → 干货/科普 → 答疑互动 → 收尾。",
    "规则：板块必须连续覆盖全部台词；每个板块 10%—35% 的时长；名字用 4—8 个中文字的短语（如「开场问候」「节气科普」「居家药膳」「答疑收尾」）。",
    "只输出 JSON：{\"blocks\":[{\"name\":\"开场问候\",\"from\":0,\"to\":12,\"minutes\":6}]}，不要解释。"
  ].join("\n");

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);

  try {
    const resp = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      signal: ac.signal,
      body: JSON.stringify({
        model: "deepseek-chat",
        temperature: 0.2,
        max_tokens: 800,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: sys },
          { role: "user", content: JSON.stringify({ totalMinutes: total, cues }) }
        ]
      })
    });
    clearTimeout(timer);
    if (!resp.ok) return json({ ok: false, error: "upstream" }, 502);

    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content || "{}";
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }

    const blocks = normalize(parsed && parsed.blocks, cues.length);
    if (!blocks.length) return json({ ok: false, error: "no blocks" }, 502);
    return json({ ok: true, blocks }, 200, { "Cache-Control": "no-store", ...gateCookie });
  } catch (e) {
    clearTimeout(timer);
    return json({ ok: false, error: "timeout" }, 504);
  }
}

/* ---------- 辅助 ---------- */
function normalize(list, n) {
  if (!Array.isArray(list)) return [];
  const out = [];
  let cursor = 0;
  for (const b of list) {
    const from = Math.max(cursor, Math.min(n - 1, Number(b && b.from)));
    const to = Math.max(from, Math.min(n - 1, Number(b && b.to)));
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    out.push({
      name: String((b && b.name) || "").replace(/[《》【】]/g, "").slice(0, 12) || ("第" + (out.length + 1) + "段"),
      from, to,
      minutes: Math.max(1, Math.min(60, Math.round(Number(b && b.minutes) || 5)))
    });
    cursor = to + 1;
    if (cursor >= n) break;
  }
  // 保证覆盖到结尾
  if (out.length && out[out.length - 1].to < n - 1) out[out.length - 1].to = n - 1;
  return out;
}

function sanitizeCues(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_CUES).map(c => ({
    sp: String((c && c.sp) || "").slice(0, 10),
    t: String((c && c.t) || "").replace(/\s+/g, " ").trim().slice(0, MAX_LEN)
  })).filter(c => c.t);
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
