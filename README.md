# DSH 自用插件四件套

四个跑在 [DeepSeek Harness](https://github.com/deepseek-ai) 上的小插件。

都是自用的。不是为了做一个产品，是干活的时候被某个具体的麻烦绊住，顺手做出来、然后一直用着的东西。所以代码风格不统一、注释不多、边界条件只覆盖我实际遇到的；能跑、够用，但不承诺通用。

| 插件 | 一句话 | 详细说明 |
| --- | --- | --- |
| [`dsh-qwen-quota`](./dsh-qwen-quota) | 输入框下面一行小字，显示千问 Token Plan 本月余额 | [README](./dsh-qwen-quota/README.md) |
| [`dsh-memory`](./dsh-memory) | 跨会话记忆：写得进去，下一个会话搜得到 | [README](./dsh-memory/README.md) |
| [`dsh-bus`](./dsh-bus) | 本机多个会话之间递话，能真推送叫醒空闲会话 | [README](./dsh-bus/README.md) |
| [`dsh-mail`](./dsh-mail) | `send_email` 工具 | [README](./dsh-mail/README.md) |

## 为什么是这四个

它们分别对应我在用 DSH 时最常撞到的四堵墙：

**看不见消耗。** 用 Token Plan 的时候，额度是个黑盒，我一天要开好几次控制台。那就把它变成输入框下面的一行字，想看的时候不用找。

**没有记忆。** 新开会话什么都不记得。这不能怪模型——它就是没有连续性。但我确实需要它记住「这个人叫什么、上次那个决定是怎么定的」，所以加了一层自己管的事实库。

**会话之间不说话。** 同一个 DSH 里跑着好几条不同的工作线，彼此不知道对方在干什么，只能靠我口头转述。于是有了总线。

**发信很烦。** 干活干到最后一步是把结果发出去，而每次「发出去」都要人去点。封成工具就完了。

## 安装

每个目录都是独立的 bundle。放进 profile 的 `node_modules`，或者用 DSH 的 `plugin_manager`：

```
plugin_manager install_bundle  --target  ./dsh-bus
```

改完代码**不会热更新**，需要先 `remove_bundle` 再 `install_bundle`。宿主侧代码改动还要重启 Harness 才生效；前端组件改完刷新页面即可。

## 共同的注意事项

- **这些插件没有经过第三方审计**，能力声明基本是 `shell` + `network` + `fs`。装之前建议先读一遍代码，都不长（最大的 `dsh-bus` 也才 800 多行）。
- Windows 上的编码坑很集中：`Set-Content -Encoding UTF8` 会写 BOM，PowerShell 5.1 按 ANSI 读 UTF-8 源码。凡是踩过的，都在各自 README 里写了。
- 数据都在用户目录（`~/.dsh-memory`、`~/.dsh-bus`），不在仓库里，也没有任何凭据被提交。

## 许可

MIT。
