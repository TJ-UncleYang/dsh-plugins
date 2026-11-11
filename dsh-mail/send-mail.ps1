param(
  [Parameter(Mandatory = $true)][string]$To,
  [string]$Subject = 'Test mail',
  [string]$Body = 'Test mail from DeepSeek Harness.',
  [string]$SubjectFile = '',
  [string]$BodyFile = '',
  [string]$SecretFile = '',
  [int]$Port = 587,
  [string[]]$AttachFile = @()
)

$ErrorActionPreference = 'Stop'

# Secret file location: golden copy is on D: drive, but $HOME is C:\Users\86137.
# Old code hard-wired (Join-Path $HOME '.mail-secret.txt') and drifted to C:, same
# root cause as the 9222 C/D profile drift. Probe candidates; do not hard-wire a drive.
if ($SecretFile -eq '') {
  $candidates = @()
  if ($env:DSH_MAIL_SECRET) { $candidates += $env:DSH_MAIL_SECRET }
  $candidates += 'D:\Users\86137\.mail-secret.txt'
  $candidates += (Join-Path $HOME '.mail-secret.txt')
  foreach ($p in $candidates) { if ($p -and (Test-Path -LiteralPath $p)) { $SecretFile = $p; break } }
}

if ($SubjectFile -ne '') { $Subject = [System.IO.File]::ReadAllText($SubjectFile, [System.Text.Encoding]::UTF8) }
if ($BodyFile -ne '') { $Body = [System.IO.File]::ReadAllText($BodyFile, [System.Text.Encoding]::UTF8) }

if (-not (Test-Path $SecretFile)) { throw "secret file not found: $SecretFile" }
$lines = @(Get-Content $SecretFile -Encoding UTF8 | Where-Object { $_.Trim() -ne '' })
if ($lines.Count -lt 2) { throw "secret file needs 2+ lines: address, then app password (got $($lines.Count))" }

$from = $lines[0].Trim()
$pass = $lines[1].Trim()

$msg = New-Object System.Net.Mail.MailMessage
$msg.From = $from
$msg.To.Add($To)
$msg.Subject = $Subject
$msg.Body = $Body
$msg.SubjectEncoding = [System.Text.Encoding]::UTF8
$msg.BodyEncoding = [System.Text.Encoding]::UTF8
$msg.IsBodyHtml = $false

foreach ($file in $AttachFile) {
  if (-not (Test-Path $file)) { throw "attachment not found: $file" }
  $msg.Attachments.Add((New-Object System.Net.Mail.Attachment($file)))
}

$client = New-Object System.Net.Mail.SmtpClient('smtp.qq.com', $Port)
$client.EnableSsl = $true
$client.Timeout = 60000
$client.DeliveryMethod = [System.Net.Mail.SmtpDeliveryMethod]::Network
$client.Credentials = New-Object System.Net.NetworkCredential($from, $pass)

try {
  $client.Send($msg)
  "SENT to $To via smtp.qq.com:$Port as $from (attachments: $($AttachFile.Count))"
} finally {
  $client.Dispose()
  $msg.Dispose()
}
