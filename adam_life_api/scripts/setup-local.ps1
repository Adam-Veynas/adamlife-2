# Keep progress visible and save each attempt separately, without exposing credentials.
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$taskLog = Join-Path '.local' ('setup-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N') + '.log')
Write-Host "Setup progress will be saved to $taskLog"
& '.\.venv\Scripts\python.exe' -u scripts\local_env.py prepare 2>&1 | Tee-Object -FilePath $taskLog
$taskExit = $LASTEXITCODE
if ($taskExit -ne 0) { exit $taskExit }
& '.\.venv\Scripts\python.exe' -u scripts\local_env.py test 2>&1 | Tee-Object -FilePath $taskLog -Append
exit $LASTEXITCODE
