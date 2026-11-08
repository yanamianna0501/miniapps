# miniapps

一套为 **MCode / Codex** 编写的小程序（miniapp）插件集合：四个彼此独立、可分别安装的本地看板，用来查看订阅额度、上下文用量、磁盘空间和模型用量。所有数据都来自本机，只读展示为主，不向第三方上传任何内容。

## 功能一览

| 名称 | 干什么 | 关键文件 |
| --- | --- | --- |
| `codex-subscription-board` | Codex / ChatGPT 订阅总览：额度窗口、重置倒计时、可用模型目录，并在本地累积每日用量趋势 | `miniapp/node/auth.mjs`、`miniapp/node/codex-api.mjs`、`miniapp/node/store.mjs` |
| `context-dashboard` | 上下文与用量仪表盘：会话数、输入/输出 token、缓存命中率、每日用量、活动热力图、上下文占用压力与构成、模型统计，可下钻到单会话逐次调用明细并导出 CSV（只读） | `miniapp/node/usage-source.mjs`、`miniapp/node/usage-report.mjs`、`miniapp/node/sqlite-bridge.py` |
| `disk-space-board` | 磁盘空间看板：按 T1–M3 分档查看扫描清单，逐项记录「清理 / 迁移 / 保留」决策并汇总可释放空间，支持目录树下钻与全量路径搜索 | `miniapp/node/rules.mjs`、`miniapp/node/index-builder.mjs`、`miniapp/node/scanner.mjs`、`miniapp/node/decision-store.mjs`、`miniapp/config.json` |
| `model-usage-hub` | 模型用量中心：合并上下文用量、Codex 与 Google Antigravity 订阅配额，统计全部已配置模型的本机 token / 缓存 / 上下文占用，并可在卡片内一键启停本地反代 | `miniapp/node/quota.mjs`、`miniapp/node/source.mjs`、`miniapp/node/proxy-controller.mjs`、`miniapp/node/service.mjs` |

> `disk-space-board` 只记录决策，**不会删除、移动或重命名**任何被测文件；全盘重扫只读取文件元数据（名称、大小、修改时间），不打开文件内容。

## 目录结构

四个小程序结构一致，各自是一个独立的插件包：

```text
miniapps/
├── .gitignore
├── LICENSE
├── README.md
├── codex-subscription-board/
├── context-dashboard/
├── disk-space-board/
└── model-usage-hub/
    ├── package.json                 # 插件入口声明：mcode.schemaVersion / mcode.miniApp
    ├── .minimax-plugin/
    │   └── plugin.json              # 插件元数据：名称、版本、描述、图标、示例提问
    ├── miniapp/
    │   ├── miniapp.json             # 小程序清单：产物目录、运行时入口、挂载路径
    │   ├── client/                  # 前端静态资源（index.html / app.js / styles.css）
    │   └── node/                    # Node 运行时（server.mjs 入口 + 各业务模块）
    ├── tests/                       # 领域用例与载荷自检脚本（仅 model-usage-hub 提供）
    └── release/                     # 打包产物 *.zip（构建产物，不入库）
```

三个清单文件各管一件事：

- **`package.json`** —— 声明这是一个 MCode miniapp 包（`mcode.schemaVersion: 2`），并指向真正的小程序清单 `mcode.miniApp: ./miniapp/miniapp.json`。
- **`.minimax-plugin/plugin.json`** —— 插件在平台侧的注册信息：`name`、`displayName`、`version`、`description`、`author`、`icon`、`category` 以及 `exampleQueries`（在对话框里可以直接问的问题示例）。
- **`miniapp/miniapp.json`** —— 小程序自身的运行时清单：`artifacts` 声明前端（`./miniapp/client`）与后端（`./miniapp/node`）产物目录；`runtime` 声明以 `process` 方式运行、入口是 `./miniapp/node/server.mjs`、生命周期为 `on-demand`（用到才拉起）；`surface.path` 决定页面挂载路径（`/dashboard`）。

运行时不需要 npm 依赖：四个包都没有第三方依赖，`npm install` 不是必需步骤。`model-usage-hub` 随包附带了一份 PyYAML（`miniapp/node/vendor/yaml/`），这样即使本机没装 PyYAML 也能解析模型配置文件。

## 安装与加载

这是一个 MCode / Codex 的 **miniapp 插件包**，安装方式取决于你使用的平台：

1. 把需要的那一个子目录（例如 `model-usage-hub/`）连同它的 `package.json`、`.minimax-plugin/`、`miniapp/` 一起拷贝到对应平台的插件目录；
2. 按平台自己的插件管理方式加载 / 启用该插件；
3. 插件被加载后即可在对话里用 `plugin.json` 里的 `exampleQueries` 提问，或直接打开它的 `/dashboard` 页面。

各平台插件目录与加载入口的位置以你所用版本的官方说明为准，本仓库不绑定任何具体命令。

加载后需要留意的地方：

- `disk-space-board` 的 `miniapp/config.json` 仓库里是**通用模板**，`sources[].file` 指向示例相对路径（如 `scan/example-elev.csv`）。请把它改成你自己的扫描清单路径（相对工作区根目录）；或者直接用页面里的「重新扫描」生成一份新快照。
- `model-usage-hub` 的各服务商 `apiKey` 在设置里填写；本地反代功能需要本机存在对应的反代脚本。

## 本地开发与测试

`model-usage-hub` 自带两个脚本，都不需要安装任何依赖：

```bash
cd model-usage-hub

# 领域用例（node:test，18 个用例：额度解析、失败即关闭、用量归属、反代控制器……）
node --test tests/domain.test.mjs

# 载荷自检：校验三份清单、对 miniapp/ 下每个 .mjs/.js 执行 node --check、
# 检查无符号链接、客户端不引用外部 URL、DOM id 与脚本选择器一致
node tests/validate.mjs

# 可选：额外做一次凭据泄漏检查（把 MCode 数据目录作为参数传进去）
node tests/validate.mjs <MCode 数据目录>
```

`tests/validate.mjs` 成功时输出一行 JSON（`"result": "PASS"`），其中 `payloadFiles` / `checkedJs` / `payloadBytes` 是载荷统计；带参数运行时会多出 `credentialLeakChecks`，表示已把配置里的 apiKey、Codex access token 与 account id 和载荷全文逐一比对，确认没有被写进代码。

运行环境要求：

- **Node.js 18+**；`model-usage-hub` 与 `context-dashboard` 优先使用内置的 `node:sqlite`，不可用时 `context-dashboard` 会退回随包的 `sqlite-bridge.py`。
- **Python 3.12**：`model-usage-hub` 用它读取 MCode 的 `config.yaml`（可由 `MODEL_HUB_PYTHON` 指定解释器）。

## 安全与隐私

- **凭据只在运行时从本机读取。** Codex CLI 的 `~/.codex/auth.json`、MCode 的 `~/.minimax/codex-auth.json` 或 `%MCODE_DATA_DIR%/codex-auth.json`、Antigravity 的本地登录文件，都是运行时现场打开、当场用完即弃。
- **不落库、不入日志。** `config-reader.py` 明确不回显异常内容，避免 YAML 解析错误把密钥所在行打印出来；仓库内不含任何 `.env`、真实 token、Cookie 或扫描清单数据。
- **API Key 由你在设置里填写**，保存在本机 MCode 数据目录，不会被写回本仓库。
- **只读优先。** 看板读取用量库时以只读模式打开（`PRAGMA query_only=ON`）；`disk-space-board` 只记录决策，不动任何文件。
- 外部请求一律走 HTTPS；如需代理，遵循标准的 `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` 环境变量。
- `model-usage-hub` 的反代控制只允许 `start` / `stop` 两个动作，且只作用于白名单内的本地反代。

## 目录约定

- `release/*.zip` 是打包好的构建产物，**不纳入版本库**（`.gitignore` 已排除 `release/*.zip` 与 `**/release/*.zip`）。需要分发时直接取本地产物即可。
- 同样被忽略的还有：`node_modules/`、`__pycache__/`、`*.pyc`、`*.log`、`.DS_Store`、`Thumbs.db`。
- 运行时产生的数据（重扫快照、清理决策记录、每日用量趋势）都写在平台分配的数据目录里，不在仓库内。

## License

[MIT](LICENSE) © 2026 yanamianna0501
