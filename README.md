# DSH 自用插件四件套

四个跑在 [DeepSeek Harness](https://github.com/deepseek-ai) 上的小插件，都来自我自己日常使用中冒出的具体麻烦。代码是自用的，能跑、够用，但不保证通用——装之前先看你有没有同样的麻烦。

| 插件 | 干什么 | 前置 |
| --- | --- | --- |
| `dsh-qwen-quota` | 在输入框下方显示千问 Token Plan 的月额度剩余，60 秒刷新一次 | 一台带调试端口（9333）且已登录千问控制台的 Edge |
| `dsh-memory` | 跨会话记忆：`memory_add` / `memory_search` / `memory_list`，SQLite FTS5 全文检索 | Node 22+（用到 `node:sqlite`） |
| `dsh-bus` | 本机多个 DSH 会话之间递话：长轮询、真推送唤醒、按 usage 折算额度、已读回执 | 无 |
| `dsh-mail` | `send_email(to, subject, body)`，走 QQ 邮箱 SMTP | Windows PowerShell 5.1 + 一个 SMTP 授权码文件 |

## 安装

每个子目录都是一个独立的 bundle，把它放进 profile 的 `node_modules`，或者在 DSH 里用 `plugin_manager` 的 `install_bundle` 指向该目录。

```bash
# 以 dsh-bus 为例
plugin_manager install_bundle --target ./dsh-bus
```

改代码之后不会热更新，需要先 `remove_bundle` 再 `install_bundle`。

## 各插件说明

### dsh-qwen-quota

读取 `platform.qianwenai.com/home/analytics/token-plan/individual` 页面上的「月额度剩余量」，通过宿主路由 `/dsh-qwen-quota` 暴露给前端组件。

- 环境变量：`DSH_CDP_HTTP`（默认 `http://127.0.0.1:9333`）、`DSH_EDGE_PATH`、`DSH_EDGE_PROFILE`
- Edge 没开时会自己拉起来（`ensureBrowser()`），拉不起来就显示「读不到」
- 页面百分比是小数（如 `58.3%`），解析按行取标签后的第一个百分数

### dsh-memory

`facts.jsonl` 是唯一真相，`memory.db` 只是索引，删了可以 `rebuild` 重建。

- 数据目录：`DSH_MEMORY_DIR`，默认 `~/.dsh-memory`
- 中文检索用 `tokenize='trigram'`，**两个字以下查不到**，所以自动退化成 `LIKE '%x%'`

### dsh-bus

多会话通信。`chat` 通道会调 `agent.followup()` 把空闲会话叫醒；`digest` 通道只落队列，不唤醒、不花钱。

- 数据目录：`DSH_BUS_DIR`，默认 `~/.dsh-bus`，打不开时退回系统临时目录
- 配置：`~/.dsh-bus/bus.json`，环境变量优先
- 额度按会话里 `assistant/message` 的 `usage` 折算人民币；模型名不在表里会走兜底价，记得补 `prices.json`
- 同一进程内可唤醒；跨进程（桌面端 + CLI）能收发但不能唤醒，因为 `ctx.agents.list()` 只看得到本进程

### dsh-mail

`send_email` 本质是拼一个 `powershell.exe` 调 `send-mail.ps1`，中文通过 UTF-8 临时文件传递，避开命令行编码问题。

- 授权码文件默认 `~/.mail-secret.txt`，第一行邮箱、第二行 SMTP 授权码；也可用 `DSH_MAIL_SCRIPT` 换脚本路径

## 已知的坑

- Windows PowerShell 5.1 按 ANSI 读 UTF-8 脚本，脚本里有中文会报 parser error → `send-mail.ps1` 保持纯 ASCII
- `Set-Content -Encoding UTF8` 会写 BOM，JS/Python 读的时候要么剥掉，要么改用 `[System.IO.File]::WriteAllText` + `UTF8Encoding($false)`
- 宿主代码改动需要重启 Harness，前端代码改完刷新页面即可

## 许可

MIT。用出问题别怪它，它就是我自己在用的东西。
