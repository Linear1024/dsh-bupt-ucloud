# dsh-ucloud

把 [YouXam/ucloud](https://github.com/YouXam/ucloud)（北邮教学云平台的 Cloudflare Worker 代理）封装成 DSH 插件：
**学号、密码在「设置 → 插件」页配置**，配置完成后 DSH 可以直接查询未完成作业、读取作业详情、搜索课程、上传附件并提交作业。

| 面 | 位置 |
|---|---|
| 设置页 | 「设置 → 插件」→ 插件列表里的 **dsh-ucloud** → 它自己的配置页（`plugins.bundle.config`，key `dsh-ucloud`，标题取自 `locale/zh.json` 的「教学云」） |
| Agent 工具 | `ucloud_undone_list`、`ucloud_homework`、`ucloud_search`、`ucloud_upload`、`ucloud_submit`、`ucloud_account` |
| 宿主路由 | `POST /dsh-ucloud/verify`（设置页「测试登录」按钮使用） |

设置页与工具读取同一份账号配置，因此页面显示的和模型用到的账号永远一致。

## 安装

```bash
dsh plugin --profile web add /absolute/path/to/dsh-ucloud
```

或者通过 `plugin_manager` 工具安装（`install_bundle`）。两种方式都会把该 bundle 写进
`dsh.profile.bundles`；新 bundle 会立即生效，但**宿主 JS 的改动需要重启 profile**
（`dsh-base` 的 HMR 配置为 `root: []`，不监听插件源码）。

本 bundle 是 `link:` 依赖，工作目录就是已安装的插件；重启后即加载最新代码。

## 配置

打开 Web UI 的 **设置 → 插件**，点开插件列表里的 **教学云 / dsh-ucloud**（配置表单就在这个 bundle 自己的页面里，不在「官方插件」区）：

| 字段 | 存放位置 | 说明 |
|---|---|---|
| 学号 | 配置档（profile）设置段 `ucloud.username` | 统一认证学号 |
| 密码 | 本机凭据库 | 统一认证密码，**不会**写入配置文件 |
| 验证码识别令牌 | 本机凭据库 | 可选；统一认证出现验证码时用 Byrdocs OCR 自动识别 |

密码与验证码令牌只写不读：页面仅显示「已配置 / 未配置」，保存后再次进入页面也不会回显。

保存后点 **测试登录**：页面会先保存未提交的改动，再调用 `POST /dsh-ucloud/verify`
真正登录一次，并显示姓名与角色（失败时显示平台或网络返回的原因）。
该路由与 `/api` 一样经过部署自身的浏览器信任检查（`ctx.connection.requestRejection`），
检查不可用时以 503 失败关闭，且响应里永远不会出现凭据。

> **关于验证码**：北邮统一认证在部分网络环境/风控下会要求输入验证码。此时若未配置
> 验证码识别令牌，登录会失败并提示 `captcha-required`。请在设置页填写 Byrdocs OCR
> token（[ocr.byrdocs.org](https://ocr.byrdocs.org)），或更换网络出口后重试。

## 工具

| 工具 | 作用 |
|---|---|
| `ucloud_undone_list` | 未完成的作业 / 测验 / 问卷，附带所属课程、教师与截止时间；课程信息会缓存到本地 |
| `ucloud_homework` | 按 `activityId` 读取作业详情：正文、课程、截止时间、`assignmentStatus`（`0`=已提交 / `99`=未提交）、`isOvertimeCommit`（`0`=可逾期补交 / `1`=不可）、提交时间、评分与附件下载地址；同时返回这些原始字段供复核 |
| `ucloud_search` | 用标题作为关键字反向搜索作业所属课程 |
| `ucloud_upload` | 从 URL 下载文件并上传为作业附件，返回 `resourceId`（默认上限 100 MB） |
| `ucloud_submit` | 提交作业（文字 + 附件 `resourceId`）——**会真实提交** |
| `ucloud_account` | 报告账号配置状态；`verify=true` 时实际登录一次并返回姓名、角色、令牌有效期 |

工具调用失败时返回稳定的错误码（`missing-username`、`missing-password`、`captcha-required`、
`login-failed`、`ocr-failed`、`upload-failed`、`submit-failed`、`upstream-error` 等）；
未配置账号时的报错会直接指向设置页路径。

## 实现说明

原 Worker 的每个 HTTP 路由都在插件内以同样的线上格式重放，区别只有承载方式：

| 原 Worker | 本插件 |
|---|---|
| HTTP Basic 鉴权（每次请求带学号密码） | 设置页一次配置：学号进配置段，密码/OCR 令牌进凭据库 |
| `env.DB`（D1）缓存令牌与课程信息 | `$DSH_HOME/ucloud/state.json`（目录 0700、文件 0600，原子写入） |
| `env.OCR_TOKEN` | 设置页的「验证码识别令牌」 |
| Worker fetch 处理器 | Host 端 `ctx.tools.register` 的六个工具 + 一条 `webServer` 路由 |
| 无前端 | Web UI 里本 bundle 页面上的 **教学云** 配置表单（`plugins.bundle.config`） |

- **登录**：移植 [`@byrdocs/bupt-auth`](https://jsr.io/@byrdocs/bupt-auth) 0.3.0（MIT）的
  CAS 统一认证流程——取 cookie/execution、必要时用 OCR 解验证码、POST 登录、用 ticket
  换取教学云令牌、读取角色并刷新出可用 access token。
- **令牌复用**：优先用缓存 access token；过期则用 refresh token 续期；refresh 被拒则重新登录。
  密码或 OCR 令牌一变，缓存的令牌立即作废（订阅 `credentials/reference-updated`）。
- **上传**：原 Worker 手写 multipart 边界并流式转发；Node 侧改用平台 `FormData`
  （undici），并在下载前/下载后都用 `maxBytes` 兜底，避免一次调用把超大文件读进内存。
- **设置命名空间**：宿主 `Config` 里 `username` 是 `.volatile()` 字段，因此 Plugins 页
  的表单可以实时编辑它；`vendor/schemastery.js` 是 `@deepseek-ai/schemastery@3.18.4`
  的单文件打包（生成方式见 `vendor/README.md`），让本插件无需声明宿主依赖即可导出 schema。

## 验证

```bash
node tests/host.test.mjs    # 51 项：登录/续期/验证码、状态存储、六个工具、设置页路由、apply 接线
node tests/client.test.mjs  # 16 项：真实 React + 真实设置组件，挂载设置卡片并驱动其 RPC 行为
```

Host 侧全部对手写 fetch 桩运行，不访问网络；Client 侧用 jsdom 加载真实的 `client.js`、
真实的 `@deepseek-ai/dsh-client-ui-primitives` 构建产物（经 `tests/loader-hooks.mjs` 解析
CSS/React/CJS 依赖），并断言：学号经设置表单保存、密码与 OCR 令牌写入凭据库、只读状态、
命名空间未就绪时的降级、凭据变更事件、测试登录的成功/失败/网络异常、以及中英文文案。

此外还用**真实 harness**（`dsh` 0.2.0-rc.2 + 一份可写的临时 profile，不动用户配置）验证过：
bundle 与 patch 正常组合、Host 模块加载成功、客户端 bundle 出现在 `__DSH_BOOT__` 图里、
`settings.describe` 返回 `ucloud` 命名空间且 `username` 可写、`settings.mutate` 写入后
`/dsh-ucloud/verify` 立刻按新学号报错（`missing-password`）。完整步骤与实测结果见
[tests/README.md](tests/README.md)。

## 安全

- 学号只来自插件的设置段，**没有**环境变量或凭据兜底：设置页显示的就是工具使用的账号。
- 密码与 OCR 令牌只存在于本机凭据库（`$DSH_HOME/.credentials.yaml`，由
  `@deepseek-ai/dsh-credentials-local` 管理），不进入配置档。
- 本地状态文件含 refresh token：目录 `0700`、文件 `0600`、临时文件 + rename 原子替换。
  每个配置档一份（`$DSH_HOME/ucloud/<profile>.json`，无配置档时为 `state.json`），
  按学号分条缓存；密码或 OCR 令牌变更会清空缓存。
- 任何返回给浏览器或模型的内容都不含凭据；`ucloud_account` 只报告"是否已配置"。
  验证码识别失败只回固定原因，不会把带 token 的 OCR 请求 URL 带进错误信息。
- 唯一的路由 `/dsh-ucloud/verify` 只做登录校验并返回姓名/角色，且有请求体大小上限。
- `ucloud_upload` 会在宿主进程里按模型给出的 URL 下载文件，这是一个 SSRF 面（可访问
  内网地址），随后还要把内容上传到教学云；只对可信 URL 使用，且单次调用有大小上限
  （默认 100 MB，超过即中止下载且不上传）。

## 许可

GPL-3.0（见 [LICENSE](LICENSE)）：本插件移植自 GPL-3.0 的 [YouXam/ucloud](https://github.com/YouXam/ucloud)，
其中的登录流程移植自 MIT 许可的 [byrdocs/bupt-auth](https://jsr.io/@byrdocs/bupt-auth) 0.3.0
（源码可用 `npm pack @jsr/byrdocs__bupt-auth --registry=https://npm.jsr.io` 取得）。
`vendor/schemastery.js` 打包自 MIT 许可的 `@deepseek-ai/schemastery`。
