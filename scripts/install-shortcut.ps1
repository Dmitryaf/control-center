param([string]$DesktopDirectory = [Environment]::GetFolderPath('Desktop'))

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$shortcutPath = Join-Path $DesktopDirectory 'Control Center.lnk'
if (Test-Path -LiteralPath $shortcutPath) {
    throw "A shortcut already exists at $shortcutPath. It has not been replaced."
}
$assets = Join-Path $root '.local\launcher'
$null = New-Item -ItemType Directory -Path $assets -Force
$iconPath = Join-Path $assets 'control-center.ico'

# Draw the same green C mark as public/favicon.svg; no external icon download.
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object Drawing.Bitmap(64, 64)
$graphics = [Drawing.Graphics]::FromImage($bitmap)
$pen = New-Object Drawing.Pen([Drawing.Color]::White, 6)
$accent = New-Object Drawing.SolidBrush([Drawing.ColorTranslator]::FromHtml('#a5d7c1'))
$stream = $null
try {
    $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.Clear([Drawing.ColorTranslator]::FromHtml('#245d51'))
    $graphics.DrawArc($pen, 12, 12, 40, 40, 45, 270)
    $graphics.FillEllipse($accent, 43, 40, 10, 10)
    # ICO supports a PNG payload, so no native icon handles need to be retained.
    $png = New-Object IO.MemoryStream
    try {
        $bitmap.Save($png, [Drawing.Imaging.ImageFormat]::Png)
        $payload = $png.ToArray()
        $stream = [IO.File]::Create($iconPath)
        $writer = New-Object IO.BinaryWriter($stream)
        $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]1)
        $writer.Write([byte]64); $writer.Write([byte]64); $writer.Write([uint16]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32)
        $writer.Write([uint32]$payload.Length); $writer.Write([uint32]22)
        $writer.Write($payload)
        $writer.Flush()
    } finally { $png.Dispose() }
} finally {
    if ($stream) { $stream.Dispose() }
    $accent.Dispose(); $pen.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
$shortcut.Arguments = '"' + (Join-Path $root 'Control Center.vbs') + '"'
$shortcut.WorkingDirectory = $root
$shortcut.IconLocation = "$iconPath,0"
$shortcut.Description = 'Open Control Center'
$shortcut.Save()
Write-Output "Created: $shortcutPath"
