$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repository = 'meharajM/ai-worker-desktop'
$apiUrl = "https://api.github.com/repos/$repository/releases?per_page=100"
$releaseRoot = "https://github.com/$repository/releases/download"

if (-not [Environment]::Is64BitOperatingSystem) {
    throw 'AI-Worker currently publishes a Windows x64 installer.'
}

$headers = @{
    Accept = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    'User-Agent' = 'AI-Worker-Installer'
}
$releases = Invoke-RestMethod -Uri $apiUrl -Headers $headers
$release = $releases | Where-Object { $_.tag_name -like 'tauri-v*' } | Select-Object -First 1
if (-not $release) {
    throw 'No published Tauri installer release was found yet.'
}

$manifestAsset = $release.assets | Where-Object { $_.name -eq 'install-manifest.txt' } | Select-Object -First 1
if (-not $manifestAsset) {
    throw 'The latest installer release does not include its platform manifest.'
}
$manifestPath = Join-Path $env:TEMP ("ai-worker-manifest-$PID.txt")
$installerPath = $null
$checksumPath = $null
try {
    Invoke-WebRequest -Uri $manifestAsset.browser_download_url -Headers $headers -OutFile $manifestPath
    $assetName = (Get-Content $manifestPath | Where-Object { $_ -like 'windows-x64=*' } | Select-Object -First 1) -replace '^windows-x64=', ''
    if ([string]::IsNullOrWhiteSpace($assetName) -or $assetName -notmatch '^AI-Worker-[A-Za-z0-9._-]+\.exe$') {
        throw 'No valid Windows installer is listed in the release manifest.'
    }

    $assetUrl = "$releaseRoot/$($release.tag_name)/$assetName"
    $installerPath = Join-Path $env:TEMP $assetName
    $checksumPath = "$installerPath.sha256"
    Invoke-WebRequest -Uri $assetUrl -Headers $headers -OutFile $installerPath
    Invoke-WebRequest -Uri "$assetUrl.sha256" -Headers $headers -OutFile $checksumPath
    $expectedHash = ((Get-Content $checksumPath -Raw).Trim() -split '\s+')[0].ToLowerInvariant()
    $actualHash = (Get-FileHash -Path $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $expectedHash) {
        throw 'The installer checksum did not match. The download was not installed.'
    }

    Write-Host "Starting AI-Worker installer $($release.tag_name)..."
    Start-Process -FilePath $installerPath -Wait
}
finally {
    @($manifestPath, $checksumPath, $installerPath) |
        Where-Object { $_ -and (Test-Path $_) } |
        Remove-Item -Force -ErrorAction SilentlyContinue
}
