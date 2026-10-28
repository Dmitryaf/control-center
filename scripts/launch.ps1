param(
    [switch]$NoBrowser,
    [switch]$NoDialog
)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$port = 4310
$mutex = $null
$locked = $false
$child = $null
$ready = $false
$logs = Join-Path $root '.local\launcher'

function Test-Ready {
    try {
        $health = Invoke-RestMethod "$base/api/health" -TimeoutSec 2
        if ($health.application -ne 'control-center' -or $health.instance -ne $instance) { return $false }
        $page = Invoke-WebRequest $base -UseBasicParsing -TimeoutSec 3
        return $page.StatusCode -eq 200 -and $page.Content.Contains('<title>Control Center</title>')
    } catch { return $false }
}

try {
    if ($env:PORT) {
        if (-not [int]::TryParse($env:PORT, [ref]$port)) { throw 'PORT должен быть числом.' }
    }
    if ($port -lt 1024 -or $port -gt 65535) { throw 'PORT должен быть от 1024 до 65535.' }
    $base = "http://127.0.0.1:$port"
    $logs = Join-Path $logs ([string]$port)
    $data = if ($env:CONTROL_CENTER_DATA_DIR) {
        if ([IO.Path]::IsPathRooted($env:CONTROL_CENTER_DATA_DIR)) { $env:CONTROL_CENTER_DATA_DIR }
        else { Join-Path $root $env:CONTROL_CENTER_DATA_DIR }
    } else { Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'ControlCenter' }
    $database = [IO.Path]::GetFullPath((Join-Path $data 'control-center.sqlite'))
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [Text.Encoding]::UTF8.GetBytes(("$root`n$database").ToLowerInvariant())
        $instance = ([BitConverter]::ToString($sha.ComputeHash($bytes))).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
    # A named mutex is released by Windows even if the launcher is interrupted.
    $mutex = New-Object Threading.Mutex($false, "Local\ControlCenter-launch-$port")
    try { $locked = $mutex.WaitOne(90000) }
    catch [Threading.AbandonedMutexException] { $locked = $true }
    if (-not $locked) { throw 'Запуск уже выполняется. Повторите попытку немного позже.' }

    $ready = Test-Ready
    if (-not $ready) {
        $connection = New-Object Net.Sockets.TcpClient
        try {
            $attempt = $connection.ConnectAsync('127.0.0.1', $port)
            try { $null = $attempt.Wait(1000) } catch { }
            if ($connection.Connected) {
                throw "Порт $port занят другой программой или другим экземпляром Control Center. Закройте его и повторите запуск."
            }
        } finally { $connection.Dispose() }
        $node = (Get-Command node.exe -ErrorAction Stop).Source
        if (-not (Test-Path (Join-Path $root 'node_modules\tsx\package.json'))) {
            throw 'Не установлены зависимости. Выполните npm ci в папке Control Center.'
        }
        $null = New-Item -ItemType Directory -Path $logs -Force
        $child = Start-Process -FilePath $node -ArgumentList @('--import', 'tsx', 'server/index.ts', '--dev') -WorkingDirectory $root -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'server.log') -RedirectStandardError (Join-Path $logs 'server-error.log') -PassThru
        $deadline = [DateTime]::UtcNow.AddSeconds(60)
        do {
            $child.Refresh()
            if ($child.HasExited) { throw 'Сервер завершился при запуске. Подробности в server-error.log.' }
            $ready = Test-Ready
            if (-not $ready) { Start-Sleep -Milliseconds 300 }
        } while (-not $ready -and [DateTime]::UtcNow -lt $deadline)
        if (-not $ready) { throw 'Сервер не запустился за 60 секунд.' }
    }
    if (-not $NoBrowser) { Start-Process $base }
    Write-Output "Control Center ready: $base"
} catch {
    # Only a process started by this invocation can be stopped on failed startup.
    if ($child -and -not $ready -and -not $child.HasExited) { Stop-Process -Id $child.Id -ErrorAction SilentlyContinue }
    $message = "Не удалось открыть Control Center.`n`n$($_.Exception.Message)`n`nЖурналы: $logs"
    if (-not $NoDialog) {
        Add-Type -AssemblyName System.Windows.Forms
        $null = [Windows.Forms.MessageBox]::Show($message, 'Control Center')
    }
    [Console]::Error.WriteLine($message)
    exit 1
} finally {
    if ($locked) { $mutex.ReleaseMutex() }
    if ($mutex) { $mutex.Dispose() }
}
