# Arvea 直播提词工作台

把直播脚本（Word）转成中控屏上能一句一句念的提词页面。纯静态，无构建步骤，直接托管在 Cloudflare Pages。

线上地址（部署后）：`https://<项目名>.pages.dev`

## 目录

```
index.html      首页
studio.html     提词工作台：拖 docx / 粘贴文字 → 自动分板块、拆句、标说话人 → 提词
guide.html      使用说明（脚本格式怎么写）
demo.html       示例：敖东专场单篇提词（不对外链接，可删）
404.html        找不到页面
_headers        Cloudflare Pages 响应头（缓存与安全头）
assets/         logo-mark.svg（主用）、arvea-logo.svg、arvea-logo.png
```

## Cloudflare Pages 部署（Git 连接）

首次：

1. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. 选 GitHub → 授权 → 选中本仓库 `prompt`
3. 构建设置：
   - Framework preset：**None**
   - Build command：**留空**
   - Build output directory：**`/`**（站点就在仓库根目录）
4. Save and Deploy

之后每次 `git push` 到 `main`，Cloudflare 会自动构建并发布，URL 不变。

## 本地预览

直接双击 `index.html` 即可（纯静态、无接口）。若浏览器对 `file://` 有安全限制，可用任意静态服务器：

```bash
npx serve .
# 或
python -m http.server 8080
```

## 数据说明

所有处理都在浏览器本地：

- 拖进来的 docx 不上传服务器，解析、拆分都在本机完成。
- 「历史脚本」「编辑后的台词」存在这台电脑的浏览器 `localStorage`：关页面、重启浏览器都在，不上服务器；换电脑或换浏览器看不到。可「导出」成 JSON 备份，需要时「导入」。
- 站点本身不需要任何后端或数据库。

## 解析规则（宽松）

- 板块标题：`环节1：暖场留人（0—4分钟）` 或 `00:00-08:00 曹医生开场｜问候回归`；完全不写则整篇合成「整场」。
- 说话人：`【曾老师】…` 或 `曹医生：…`；带角色后缀（医生/老师/主持/助手/顾问…）直接认，没有后缀但出现两次以上也认。
- 没写名字的段落归给上一位说话人；`时间：`、`主题：`、`备注：` 这类不会被当成说话人。
- `KT1/KT3（算账板）：`、`环节内容：`、`话术参考：`、`物料清单` 等噪声行会被跳过。

详细示例见 `guide.html`。

## 许可

内部项目，未开源授权。

## AI 兜底对齐（可选）

字面匹配在「脱稿 / 意译 / 双人抢话」时会进入待命。此时前端会异步请求 `/api/align`，由 DeepSeek 在候选句里重排一次（不阻塞高亮）。

- 代码：`functions/api/align.js`（Cloudflare Pages Function）
- 启用：Pages 项目 → Settings → Environment variables → 添加 `DEEPSEEK_API_KEY`
- 未配置时：接口返回 500，前端静默跳过，跟读照常按字面工作
- 本地调试：`powershell -File tests/ai-proxy.ps1`（需先设 `$env:DEEPSEEK_API_KEY`），页面加参数 `?ai=http://127.0.0.1:8788/api/align`

链路分工：

```
麦克风 → ASR（流式，150–300ms）→ 字面匹配 + 语义先验（本地，5–20ms）→ 高亮
                                   ↓ 置信度 < 0.45 且距上次 > 2.5s
                                /api/align（DeepSeek，300–900ms，异步纠正）
```
## 本地离线识别（whisper-tiny，可选）

页面上加 `?asr=local` 走本地模型（离线、免费、不联网）；不加则用浏览器自带语音识别。

- worker：`assets/asr/whisper-worker.js`（transformers.js + onnxruntime-web，已打包，758KB）
- 模型：**不进仓库**（40MB+，且合并版解码器 29MB 超过 Pages 单文件 25MB 上限）
  - 默认远端：worker 找不到站内模型时，自动回落到 `https://hf-mirror.com`，首次加载后浏览器缓存，之后可离线
  - 想完全站内：把模型放到 `assets/asr/models/Xenova/whisper-tiny/`、ORT 运行库放到 `assets/asr/ort/`（本地开发够用；线上建议放 R2 再改 `env.localModelPath`）
- 实测（本机 i7，wasm 单线程）：8.12s 音频解码 2.85s，RTF≈0.35；模型冷启动约 1s

延迟参考：

| 方案 | 端到端延迟 | 成本 |
|---|---|---|
| 浏览器语音识别（默认） | 0.5–1.5s | 0（受网络/区域影响大） |
| 本地 whisper-tiny | 约 3s（2.5s 分块 + 0.9s 解码） | 0，离线可用 |
| 云端流式 ASR | 0.2–0.3s | ¥2–3/小时 |