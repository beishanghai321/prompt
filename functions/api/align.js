/**
 * /api/align —— 跟读兜底对齐（DeepSeek 重排）
 *
 * 只在字面匹配置信度低时调用（脱稿、意译、双人抢话），异步、不阻塞高亮。
 * key 只存在 Cloudflare 环境变量 DEEPSEEK_API_KEY，前端永远拿不到。
 *
 * 请求：POST /api/align
 *   { text: "最近听清的 120 字", candidates: [{i: 12, sp: "曾老师", t: "…"}, …], hint: 17 }
 * 返回：
 *   { index: 12, confidence: 0.82, reason: "…" }
 *   index = -1 表示都不像（脱稿）
 */
export async function onRequestGet() {
  return json({ ok: true, model: "deepseek-chat", endpoint: "/api/align" });
}

export async function onRequestPost({ request, env }) {
  const key = env.DEEPSEEK_API_KEY;
  if (!key) return json({ error: "DEEPSEEK_API_KEY 未配置" }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "请求体不是合法 JSON" }, 400);
  }

  const text = String(body.text || "").slice(-200);
  const candidates = Array.isArray(body.candidates) ? body.candidates.slice(0, 30) : [];
  const hint = Number.isFinite(body.hint) ? body.hint : -1;
  if (!text || !candidates.length) return json({ index: -1, confidence: 0 }, 200);

  const sys = [
    "你是直播提词的实时对齐引擎。",
    "输入是一段刚识别到的语音文本（可能有错字、口头语、重复），以及若干句脚本候选。",
    "任务：判断说话人当前正在念哪一句候选。允许意译、同义改写、加口头语、跳句。",
    "若这段语音明显不在任何候选里（自由发挥/闲聊），返回 -1。",
    "只输出 JSON：{\"index\": 候选的 i, \"confidence\": 0~1, \"reason\": \"不超过 15 字的中文理由\"}",
    "不要输出任何其它文字。"
  ].join("\n");

  const user = JSON.stringify({
    heard: text,
    lastMatchedIndex: hint,
    candidates: candidates.map((c) => ({ i: c.i, speaker: c.sp || "", text: String(c.t || "").slice(0, 90) }))
  }, null, 0);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 1800);   // 兜底请求不许拖太久

  try {
    const resp = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      signal: ac.signal,
      body: JSON.stringify({
        model: "deepseek-chat",
        temperature: 0,
        max_tokens: 80,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user }
        ]
      })
    });
    clearTimeout(timer);

    if (!resp.ok) {
      const t = await resp.text();
      return json({ error: "upstream " + resp.status, detail: t.slice(0, 200) }, 502);
    }
    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content || "{}";
    let out = {};
    try { out = JSON.parse(raw); } catch { out = {}; }

    const idx = Number(out.index);
    const conf = Math.max(0, Math.min(1, Number(out.confidence) || 0));
    const valid = candidates.some((c) => c.i === idx);
    return json({
      index: valid ? idx : -1,
      confidence: valid ? conf : 0,
      reason: typeof out.reason === "string" ? out.reason.slice(0, 40) : ""
    }, 200, { "Cache-Control": "no-store" });
  } catch (e) {
    clearTimeout(timer);
    return json({ error: "timeout", detail: String(e && e.message || e).slice(0, 120) }, 504);
  }
}

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra }
  });
}
