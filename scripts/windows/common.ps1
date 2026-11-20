# Shared helpers: repo root and loading .env into the process environment.
$Root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
function Import-DotEnv {
    $envFile = if ($env:DOTENV) { $env:DOTENV } else { Join-Path $Root '.env' }
    if (-not (Test-Path $envFile)) { throw "Missing $envFile. Run: node scripts/new-keeper.js" }
    foreach ($line in Get-Content $envFile) {
        if ($line -match '^\s*#' -or $line -notmatch '=') { continue }
        $name, $value = $line -split '=', 2
        if ($value.Trim()) { Set-Item -Path "Env:$($name.Trim())" -Value $value.Trim() }
    }
}
