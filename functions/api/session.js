/**
 * /api/session —— 查询当前浏览器是否已登录
 * 返回 { ok: true, authed: true } 或 { ok: true, authed: false }
 *
 * 同时导出 requireAuth()，给 AI 接口复用：未登录直接 401，避免额度被白用。
 */
import { verifyToken, readCookie, secretOf, json, sameOrigin } from "./login.js";

export async function onRequestGet({ request, env }) {
  const data = await currentSession(request, env);
  return json({ ok: true, authed: !!data });
}

/** 校验会话；有效返回 payload，否则 null */
export async function currentSession(request, env) {
  if (!env || !env.ARVEA_PASS) return null;
  const token = readCookie(request, "tyc_sess");
  if (!token) return null;
  return await verifyToken(token, secretOf(env));
}

/** AI 接口守卫：未登录返回 401 响应，已登录返回 null */
export async function requireAuth(request, env) {
  if (!sameOrigin(request)) return json({ ok: false, error: "forbidden" }, 403);
  const data = await currentSession(request, env);
  if (!data) return json({ ok: false, error: "请先登录" }, 401);
  return null;
}
