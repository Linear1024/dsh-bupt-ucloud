# dsh-bupt-ucloud

北邮教学云平台（ucloud）的 DSH 插件：**学号、密码在「设置 → 插件」页配置**，配置完成后
DSH 可以直接查询未完成作业、读取作业详情、核对已交/未交、上传附件并提交作业。

| 面 | 位置 |
|---|---|
| 设置页 | 「设置 → 插件」→ 插件列表里的 **dsh-bupt-ucloud** → 它自己的配置页（`plugins.bundle.config`，key `dsh-bupt-ucloud`，标题取自 `locale/zh.json` 的「教学云」） |
| Agent 工具 | `ucloud_undone_list`、`ucloud_works`、`ucloud_homework`、`ucloud_search`、`ucloud_upload`、`ucloud_submit`、`ucloud_account`、`ucloud_login` |
| 宿主路由 | `POST /dsh-bupt-ucloud/verify`（设置页「测试登录」按钮使用） |

设置页与工具读取同一份账号配置，因此页面显示的和模型用到的账号永远一致。

## 安装

```bash
dsh plugin --profile web add /absolute/path/to/dsh-bupt-ucloud
```

或者通过 `plugin_manager` 工具安装（`install_bundle`）。两种方式都会把该 bundle 写进
`dsh.profile.bundles`；新 bundle 会立即生效，但**宿主 JS 的改动需要重启 profile**
（`dsh-base` 的 HMR 配置为 `root: []`，不监听插件源码）。

本 bundle 是 `link:` 依赖，工作目录就是已安装的插件；重启后即加载最新代码。

## 配置

打开 Web UI 的 **设置 → 插件**，点开插件列表里的 **教学云 / dsh-bupt-ucloud**（配置表单就在这个 bundle 自己的页面里，不在「官方插件」区）：

| 字段 | 存放位置 | 说明 |
|---|---|---|
| 学号 | 配置档（profile）设置段 `ucloud.username` | 统一认证学号 |
| 密码 | 本机凭据库 | 统一认证密码，**不会**写入配置文件 |
| 验证码识别令牌 | 本机凭据库 | 可选；填了就能自动识别验证码，不填则改为人工/视觉识别（见下） |

密码与验证码令牌只写不读：页面仅显示「已配置 / 未配置」，保存后再次进入页面也不会回显。

保存后点 **测试登录**：页面会先保存未提交的改动，再调用 `POST /dsh-bupt-ucloud/verify`
真正登录一次，并显示姓名与角色（失败时显示平台或网络返回的原因）。
该路由与 `/api` 一样经过部署自身的浏览器信任检查（`ctx.connection.requestRejection`），
检查不可用时以 503 失败关闭，且响应里永远不会出现凭据。

> **关于验证码**：北邮统一认证在部分网络环境/风控下会要求输入验证码。有两种应对方式：
> 1. 在设置页填 Byrdocs OCR token（[ocr.byrdocs.org](https://ocr.byrdocs.org)），之后全自动；
> 2. 不填也行——插件会把验证码图片存到 `$DSH_HOME/ucloud/captcha-<id>.png`，模型可以用
>    `read_image` 读它（或让你看一眼后把文字告诉模型），再调用 `ucloud_login` 完成登录。

## 工具

| 工具 | 作用 |
|---|---|
| `ucloud_undone_list` | 未完成的作业 / 测验 / 问卷：课程、教师、截止时间；**24 小时内截止的单独成段（🔴）**，已过期且不可补交的另列一段、不计入待办 |
| `ucloud_works` | 遍历所有课程，列出**已提交 / 未提交**清单（可加 `filter`、`course`）——用于核对某次提交是否真的落到「已提交」里 |
| `ucloud_homework` | 按 `activityId` 读详情：正文、课程、章节、开始/截止、`assignmentStatus`（`0`=已提交 / `99`=未提交）、`isOvertimeCommit`（`0`=可补交 / `1`=不可）、提交时间、评分、题目附件与下载地址；`raw=true` 可打印平台返回的**全部原始字段**（可用 `fields` 过滤） |
| `ucloud_search` | 用标题作为关键字反查作业所属课程 |
| `ucloud_upload` | 上传附件，返回 `resourceId`：给 `path` 传本地文件（绝对路径，或相对**当前会话工作区**），或给 `url` 传远程文件；**默认沿用源文件自己的名字**，MIME 按扩展名识别；单次上限 100 MB |
| `ucloud_submit` | 提交作业（文字 + 附件 `resourceId`）——**会真实提交** |
| `ucloud_account` | 账号状态（学号/姓名/userId/角色）；`verify=true` 时实际登录一次；遇到验证码会返回图片路径与 `captchaId` |
| `ucloud_login` | 用 `captchaId` + 验证码文字完成一次被验证码拦住的登录（5 分钟内有效） |

工具调用失败时返回稳定的错误码（`missing-username`、`missing-password`、`captcha-required`、
`captcha-expired`、`login-failed`、`ocr-failed`、`file-too-large`、`upload-failed`、
`submit-failed`、`upstream-error` 等）；未配置账号时的报错会直接指向设置页路径。

推荐流程：`ucloud_undone_list` 看待办 → `ucloud_homework` 读题目 → `ucloud_upload` 传附件
（先把 `resourceId` 报给用户确认）→ `ucloud_submit` 提交 → `ucloud_homework` 复核
`assignmentStatus` 是否变成 `0` → `ucloud_works` 确认它出现在「已提交」列表里。

## 实现说明

- **凭据**：学号在配置档设置段，密码与验证码令牌在本机凭据库；两者都不进配置文件。
- **登录**：CAS 统一认证——取 cookie/execution → 需要验证码时走 OCR 或人工识别 →
  POST 登录 → ticket 换取教学云令牌 → 读取角色 → 刷新出可用 access token。
- **会话**：优先用缓存 access token；过期用 refresh token 续期；续期被拒则重新登录；
  密码或验证码令牌变更时立即清空缓存（订阅 `credentials/reference-updated`）。
- **令牌与课程缓存**：`$DSH_HOME/ucloud/<profile>.json`，目录 `0700`、文件 `0600`、
  临时文件 + rename 原子写。
- **平台接口**：`/ykt-site/**`、`/blade-source/**`、`/ykt-basics/oauth/token`，请求头与
  参数按平台前端一致；课程 ID 一律按字符串比较（19 位 ID 超出 double 精度）。
- **上传**：本地路径直接读文件，相对路径以**调用会话的工作区**为基准
  （`exec.agent.session.header.cwd`，与内置 fs 工具同一来源；取不到时才退回 profile 的第一个工作区）；
  URL 则边读边计数，两者都受 `maxBytes`（默认 100 MB）约束，越界立即中止且不上传；
  统一用平台 `FormData` 提交，附件名默认沿用源文件自己的名字。
- **令牌边界**：access token 距到期 60 秒内即视为过期并先续期（与工作区 CLI 的规则一致），
  避免"刚过期"那一次请求白挨一个 `HTTP 401`。
- **返回值**：所有工具的结构化返回值统一过一遍 `undefined → null`，
  因为 DSH 要求工具结果是**无损 JSON**——平台字段缺失时返回 `null`，而不是让整次调用报错。
- **设置命名空间**：宿主 `Config` 里 `username` 是 `.volatile()` 字段，因此 Plugins 页
  的表单可以实时编辑它；`vendor/schemastery.js` 是 `@deepseek-ai/schemastery@3.18.4`
  的单文件打包（生成方式见 `vendor/README.md`），让本插件无需声明宿主依赖即可导出 schema。

## 验证

```bash
node tests/host.test.mjs    # 62 项：登录/续期/验证码、状态存储、八个工具、设置页路由、apply 接线
node tests/client.test.mjs  # 16 项：真实 React + 真实设置组件，挂载设置卡片并驱动其 RPC 行为
```

Host 侧全部对手写 fetch 桩运行，不访问网络；Client 侧用 jsdom 加载真实的 `client.js`、
真实的 `@deepseek-ai/dsh-client-ui-primitives` 构建产物（经 `tests/loader-hooks.mjs` 解析
CSS/React/CJS 依赖），并断言：学号经设置表单保存、密码与 OCR 令牌写入凭据库、只读状态、
命名空间未就绪时的降级、凭据变更事件、测试登录的成功/失败/网络异常、以及中英文文案。

此外还用**真实 harness**（`dsh` 0.2.0-rc.2 + 一份可写的临时 profile，不动用户配置）验证过：
bundle 与 patch 正常组合、Host 模块加载成功、客户端 bundle 出现在 `__DSH_BOOT__` 图里、
`settings.describe` 返回 `ucloud` 命名空间且 `username` 可写、`settings.mutate` 写入后
`/dsh-bupt-ucloud/verify` 立刻按新学号报错（`missing-password`）。完整步骤与实测结果见
[tests/README.md](tests/README.md)。

## 安全

- 学号只来自插件的设置段，**没有**环境变量或凭据兜底：设置页显示的就是工具使用的账号。
- 密码与验证码令牌只存在于本机凭据库（`$DSH_HOME/.credentials.yaml`，由
  `@deepseek-ai/dsh-credentials-local` 管理），不进入配置档。
- 本地状态文件含 refresh token：目录 `0700`、文件 `0600`、临时文件 + rename 原子替换。
  每个配置档一份（`$DSH_HOME/ucloud/<profile>.json`，无配置档时为 `state.json`），
  按学号分条缓存；密码或验证码令牌变更会清空缓存。
- 验证码图片同样 `0600` 写入插件自己的目录，登录成功后立即删除。
- 任何返回给浏览器或模型的内容都不含凭据；`ucloud_account` 只报告"是否已配置"。
  验证码识别失败只回固定原因，不会把带 token 的 OCR 请求 URL 带进错误信息。
- 唯一的路由 `/dsh-bupt-ucloud/verify` 只做登录校验并返回姓名/角色，且有请求体大小上限。
- `ucloud_upload` 会在宿主进程里读本地文件、或按模型给出的 URL 下载文件，这是一个
  SSRF / 本地文件外发面（可访问内网地址、可读本机文件），随后把内容上传到教学云；
  只对可信的来源使用，且单次调用有大小上限（默认 100 MB，超过即中止且不上传）。

## 已知限制

- **不能切换账号**：账号固定来自设置页 + 凭据库（这也是它和工作区 CLI 唯一的定位差异；
  需要多账号切换时请用 `tools/ucloud-cli.mjs`）。
- **没有删除资源的能力**：上传成功但没用上的附件无法通过本插件删除，只会在教学云里留一个
  游离资源。平台是否提供删除接口本插件未使用、也未验证——不猜、不试探未经确认的端点。
- **没有 dry-run**：`ucloud_submit` 一调用就是真提交；约定是先把 `resourceId` 报给用户确认再提交。
- **验证码需要人读图**：未配置 OCR 令牌时，登录会停下并给出图片路径与 `captchaId`，
  由模型（`read_image`）或用户读出文字后调用 `ucloud_login` 继续。

## 许可

GPL-3.0（见 [LICENSE](LICENSE)）：接口封装源自 GPL-3.0 的
[YouXam/ucloud](https://github.com/YouXam/ucloud)，登录流程源自 MIT 的
[byrdocs/bupt-auth](https://jsr.io/@byrdocs/bupt-auth) 0.3.0
（源码可用 `npm pack @jsr/byrdocs__bupt-auth --registry=https://npm.jsr.io` 取得）。
`vendor/schemastery.js` 打包自 MIT 许可的 `@deepseek-ai/schemastery`。
