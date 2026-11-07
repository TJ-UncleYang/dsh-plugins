# dsh-qwen-quota

在 DeepSeek Harness 的输入框下方，显示千问 Token Plan 这个月的额度还剩多少。

我每天要问它十几次「还能用多久」，每次都得开浏览器登录控制台翻一眼，次数多了就烦了。于是做了这个东西：一行小字，常驻在输入框下面，60 秒自己刷新。

```
[今日额度] Lite · 剩余 58.3% · 重置 12-04 · 剩 363 天
```

## 它是怎么读到数字的

千问的额度没有公开的接口给个人版 key 用（Token Plan 的 `sk-sp-` key 只能调模型，调不了账单），所以走的是**页面**：

1. 找一台开着远程调试端口（默认 9333）的 Edge；
2. 用 CDP 连上去，对你的**已登录**页面求值，把 `document.body.innerText` 拿回来；
3. 按行解析——找「月额度」那一行，取它后面第一个形如 `58.3%` 的行；「重置时间」「剩余天数」「状态」「套餐」同理。

也就是说：**它读到的是你浏览器里已经登录的那个账号**。没有登录态，它就只会显示「读不到」。

## 前置

- Windows + Edge（Chrome 同理，改 `DSH_EDGE_PATH` 即可）
- 一台带着调试端口的 Edge，且里面登录着 <https://platform.qianwenai.com>
- Node 22+（宿主环境自带）

启动这个 Edge 的样子：

```bat
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" ^
  --user-data-dir="%LOCALAPPDATA%\dsh-browser\zhihu-watch" ^
  --remote-debugging-port=9333 ^
  --no-first-run --no-default-browser-check ^
  https://platform.qianwenai.com/home/analytics/token-plan/individual
```

## 配置

全部走环境变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DSH_CDP_HTTP` | `http://127.0.0.1:9333` | CDP 地址 |
| `DSH_EDGE_PATH` | `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe` | 拉不起来时用它自己启动 |
| `DSH_EDGE_PROFILE` | `~/AppData/Local/dsh-browser/zhihu-watch` | Edge 的 `--user-data-dir` |

## 它暴露的东西

- 宿主路由：`GET /dsh-qwen-quota` → `{status, percent, resetAt, plan, daysLeft, planStatus, updatedAt, error}`
- 加 `?refresh=1` 会先现读一次再返回
- 前端组件挂在 `conversation.composer.dock`，`order: 6`
- 前端每 60 秒调一次；如果宿主自己还没刷新，就再补一次 `refresh=1`

## 已知的毛病

- **页面一改版就废**。它靠 innerText 的标签文字定位，不是结构化的数据。千问改一处措辞，这里就得跟着改 `parseQuotaText`。
- 百分比从整数变成了小数（`83%` → `58.3%`）的时候我踩过一次坑，正则只认整数，结果一直显示「读不到」。现在按 `^[\d.]+%$` 匹配。
- 浏览器没开的时候它会把 Edge 拉起来（`ensureBrowser()` 最多等 25 秒），但在锁屏/远程桌面断开时拉不起来，只能等下次。
- 只支持一个账号、一个 workspace。多账号不做，因为我自己只有一个。

## 许可

MIT。
