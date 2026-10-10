param(
  [Parameter(Mandatory = $true)]
  [string]$BackupZip,
  [string]$Repository = "https://github.com/LU9DI/zion.git",
  [string]$Branch = "main"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  throw "Git for Windows is required. Install it from https://git-scm.com/download/win."
}
if (-not (Test-Path -LiteralPath $BackupZip -PathType Leaf)) {
  throw "Backup ZIP not found: $BackupZip"
}
$zip = (Resolve-Path -LiteralPath $BackupZip).Path
$work = Join-Path $env:TEMP ("zion-import-" + [guid]::NewGuid().ToString("N"))
$extract = Join-Path $work "extract"
$checkout = Join-Path $work "repo"

try {
  New-Item -ItemType Directory -Path $extract -Force | Out-Null
  Expand-Archive -LiteralPath $zip -DestinationPath $extract -Force

  $source = Get-ChildItem -LiteralPath $extract -Directory -Recurse |
    Where-Object { $_.Name -eq "zion-v0.33.32-continuity-recovery" } |
    Select-Object -First 1
  if (-not $source) {
    throw "Could not find source/zion-v0.33.32-continuity-recovery inside the preservation ZIP."
  }

  git clone --branch $Branch $Repository $checkout
  if ($LASTEXITCODE -ne 0) { throw "git clone failed; verify network access and GitHub permission." }

  # Merge every source file by relative path, including dotfiles, without touching .git.
  Get-ChildItem -LiteralPath $source.FullName -Force -Recurse | ForEach-Object {
    $relative = $_.FullName.Substring($source.FullName.Length).TrimStart([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    $destination = Join-Path $checkout $relative
    if ($_.PSIsContainer) {
      New-Item -ItemType Directory -Path $destination -Force | Out-Null
    } else {
      $parent = Split-Path -Parent $destination
      New-Item -ItemType Directory -Path $parent -Force | Out-Null
      Copy-Item -LiteralPath $_.FullName -Destination $destination -Force
    }
  }

  # The preserved tree intentionally contains only a license notice. Before publishing,
  # replace it with the official AGPL-3.0 text because package.json declares AGPL-3.0-only.
  $licenseUrl = "https://www.gnu.org/licenses/agpl-3.0.txt"
  $licensePath = Join-Path $checkout "LICENSE"
  Invoke-WebRequest -Uri $licenseUrl -OutFile $licensePath
  if (-not (Test-Path -LiteralPath $licensePath -PathType Leaf) -or (Get-Item $licensePath).Length -lt 10000) {
    throw "Could not retrieve the complete official AGPL-3.0 license; refusing to publish."
  }

  Push-Location $checkout
  try {
    # Validate the actual merged checkout before pushing anything.
    npm run check
    if ($LASTEXITCODE -ne 0) { throw "Syntax checks failed; refusing to publish." }
    npm test
    if ($LASTEXITCODE -ne 0) { throw "Tests failed; refusing to publish." }
    npm run demo
    if ($LASTEXITCODE -ne 0) { throw "Demo smoke test failed; refusing to publish." }
    npm run client:demo
    if ($LASTEXITCODE -ne 0) { throw "Client demo failed; refusing to publish." }

    git add -A
    if ($LASTEXITCODE -ne 0) { throw "git add failed." }
    git diff --cached --quiet
    if ($LASTEXITCODE -eq 0) {
      Write-Host "No changes to commit; the source appears already imported."
      exit 0
    }
    git -c user.name="Zion Source Import" -c user.email="zion-source-import@users.noreply.github.com" commit -m "Publish complete preserved source tree v0.33.32"
    if ($LASTEXITCODE -ne 0) { throw "git commit failed." }
    git push origin $Branch
    if ($LASTEXITCODE -ne 0) { throw "git push failed; the commit remains in the temporary checkout." }
    Write-Host "Source tree pushed to $Repository ($Branch)."
    Write-Host "Published checkout passed npm run check, npm test, npm run demo, and npm run client:demo."
  } finally {
    Pop-Location
  }
} finally {
  if (Test-Path -LiteralPath $work) {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
  }
}