# Polyglot — 图片提示词机器翻译部署分支

基于 FxEmbed/polyglot 提交 `3586e9d45e4b3ac02649a744f1775231408054ab`，为本服务器图片 API 维护小范围本地补丁。保留上游 LICENSE。本分支不是通用聊天翻译服务，不接 CPA 文本模型。

## 当前行为

- 使用上游相同版本的 Google (`@vitalets/google-translate-api@9.2.1`) 与 Bing (`bing-translate-api@4.1.0`) 机器翻译依赖。
- 生产调度只启用 Google 直连（5 秒）、Bing 直连（5 秒）、Google 经 TW（12 秒）；后者仅在 `GOOGLE_TW_PROXY_FILE` 存在时启用。
- 不启用公共 DeepLX 代理、付费供应商或聊天大模型。原 `providers/` 文件保留供对照，生产入口不加载它们。
- 每条路线连续失败 3 次，冷却 60 秒后允许一次恢复探测。
- 每次翻译硬预算 24 秒；调用方图片服务另有 25 秒阶段预算。每个供应商调用运行在可终止 worker 中，超时、断连或同批任务失败会终止 worker，关闭它持有的代理连接。
- 正文按标点切分为不超过 900 UTF-16 单元的片段，保留换行与顺序，并发最多 2。空结果、未翻译的中日韩片段、HTML 不作为成功结果。
- 纯英文/无需 CJK 翻译的片段直接保留。最多 16 个正在处理的 HTTP 请求，超出返回 429。
- 服务仅用于提示词到英文的转换：`target_lang` 必须为 `en`；不提供任意目标语言的通用公共服务。
- 日志仅记录路线、耗时、结果类别，不记录输入、译文、代理密码或第三方原始错误。

## 接口

`GET /ping` 为存活检查，不代表供应商已经成功翻译。

`POST /translate` 必须携带 `Authorization: Bearer <服务令牌>`：

```json
{"text":"雨后的街道\n霓虹灯倒映在水面上","target_lang":"en"}
```

```json
{"translated_text":"street after rain\nNeon lights reflected on the water","source_lang":"auto","target_lang":"en","provider":"google"}
```

输入最多 20000 UTF-16 单元、HTTP 请求体最多 64 KiB；支持可选 `source_lang`。无有效结果为 `503 translation_unavailable`，超时为 `504 translation_timeout`。不要仅以 HTTP 200 判断翻译是否完成；图片服务也会再次校验译文。

## 构建与验证

固定 Bun `1.3.9`，依赖以 `bun.lock` 为准：

```bash
bun install --frozen-lockfile
bun test
bunx tsc --noEmit
docker build -t polyglot:1.0.0-3586e9d-local1 .
```

服务令牌必须通过 `ACCESS_TOKEN_FILE` 提供（开发兼容 `ACCESS_TOKEN`，不用于生产 Compose）。TW 代理 URL 从 `GOOGLE_TW_PROXY_FILE` 读取，不能写入仓库。

生产唯一配置与运行说明在 `/srv/stacks/polyglot`。容器仅在私有翻译网络与 `proxy-egress` 上运行，没有公网入口或宿主机端口；只读根文件系统、非 root 用户和限额由生产 Compose 设置。
