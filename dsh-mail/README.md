# dsh-mail

给 DeepSeek Harness 一个 `send_email(to, subject, body)` 工具。

起因很无聊：我要把一份日报发到自己邮箱，每次都得自己开客户端粘一遍。既然工具能调文件、能跑命令，那发信也该是一个工具。

## 工具

```json
send_email({
  "to": "someone@example.com",
  "subject": "标题",
  "body": "正文（纯文本）"
})
```

返回 `已发送到 someone@example.com`，或者一个明确的失败原因。

限制：正文 ≤ 20000 字、标题 ≤ 200 字、单次 60 秒超时、不支持附件（附件是我另一个脚本干的事）、不会并发发送。

## 它其实是个壳

真正的发信动作在 `send-mail.ps1` 里，插件只是：

1. 把标题和正文写成两个 UTF-8 临时文件；
2. `spawn` 一个 `powershell.exe -NoProfile -ExecutionPolicy Bypass -File send-mail.ps1 -To ... -SubjectFile ... -BodyFile ...`；
3. 拿到退出码和 stdout，翻译成人话返回。

**为什么非要落成文件？** 因为中文正文直接当命令行参数传，在 Windows 上会被代码页吃掉，变成一堆问号。落成 UTF-8 文件，脚本里用 `-Encoding UTF8` 读，就干净了。

## 前置

- Windows（用 `System.Net.Mail`，所以是 PowerShell 的事；Linux/macOS 请自己换实现）
- 一个支持 SMTP 的邮箱。我用的是 QQ 邮箱，`smtp.qq.com:587` + STARTTLS
- **授权码**，不是登录密码

## 授权码放哪

默认读 `~/.mail-secret.txt`，两行：

```
your@qq.com
xxxxxxxxxxxxxxxx
```

第一行是你发信用的地址，第二行是 QQ 邮箱设置里生成的 16 位授权码。

想换个位置就设 `DSH_MAIL_SCRIPT` 环境变量——不，那是换脚本路径。换密钥文件路径请直接改 `send-mail.ps1` 里的 `$SecretFile`，或者传 `-SecretFile`。

## 已知的毛病

- **脚本必须保持纯 ASCII**。Windows PowerShell 5.1 按 ANSI 读 UTF-8 源码，只要 `send-mail.ps1` 里出现中文就会报 parser error（`Missing ')' in function parameter list`）。我为此把注释全改成英文了。
- 只支持一个发信账号。多账号要改脚本参数。
- 不做重试。发失败就报错，让我自己决定要不要再发一次。
- QQ 邮箱有频率限制，连着发几十封会被限，正常用不会碰到。

## 许可

MIT。
