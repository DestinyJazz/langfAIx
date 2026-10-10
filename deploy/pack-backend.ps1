# Packs the files needed to build the backend image into one tar archive.
#
# For deployments where the Docker host cannot build from a Git checkout: upload the
# archive to the host (for example on Portainer's Images page) and build the image there.
# If you can build from the repo, `docker compose build` does the same without this script.
#
# The Word add-in's pages are in the archive too: the backend serves them (under
# /api/addin/), so they ship with it.
#
# Usage (in PowerShell, from the repo root):
#   powershell -ExecutionPolicy Bypass -File deploy/pack-backend.ps1
#
# Output: deploy/build/langfaix-backend.tar

$ErrorActionPreference = "Stop"

$root    = Split-Path -Parent $PSScriptRoot      # repo root
$backend = Join-Path $root "backend"
$outDir  = Join-Path $PSScriptRoot "build"
$outFile = Join-Path $outDir "langfaix-backend.tar"
$staging = Join-Path $outDir "backend-staging"   # staging folder: the files are collected here first
$tar     = "$env:SystemRoot/System32/tar.exe"    # the system tar, by full path, so no other tar is picked up

function Fail($message) {
    Write-Host "PACK FAILED: $message" -ForegroundColor Red
    exit 1
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
if (Test-Path $outFile) { Remove-Item $outFile }
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Force -Path $staging | Out-Null

# ---------- The backend's own files ----------
# Only what the image build needs. Not the virtual environment (large, and Windows
# binaries) and not the tests (unused at run time).
foreach ($name in @("Dockerfile", ".dockerignore", "requirements.txt")) {
    Copy-Item -Path (Join-Path $backend $name) -Destination $staging
}
Copy-Item -Path (Join-Path $backend "app") -Destination $staging -Recurse
Get-ChildItem -Path $staging -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force

# ---------- The Word add-in's pages ----------
# They go under app/static/addin/ in the image, mirroring the repo layout:
#   word-addin/...             the add-in's own pages
#   browser-extension/lib/...  the rules shared with the browser extension
# so `import "../browser-extension/lib/xxx.js"` resolves in the repo and on the server alike.
# Only file types the pages use. No tests, no manifest template, no package.json.
$addin    = Join-Path $staging "app/static/addin"
$webTypes = @(".html", ".js", ".css", ".png")
$sources  = @(
    @{ From = (Join-Path $root "word-addin");            To = "word-addin" },
    @{ From = (Join-Path $root "browser-extension/lib"); To = "browser-extension/lib" }
)
$addinFiles = @()
foreach ($source in $sources) {
    if (-not (Test-Path $source.From)) { Fail "the folder $($source.From) is missing" }
    foreach ($file in Get-ChildItem -Path $source.From -Recurse -File) {
        $rel = $file.FullName.Substring($source.From.Length + 1).Replace("\", "/")
        if ($rel -like "tests/*" -or $rel -like "node_modules/*") { continue }
        if ($webTypes -notcontains $file.Extension.ToLower()) { continue }
        $target = Join-Path $addin "$($source.To)/$rel"
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
        Copy-Item -Path $file.FullName -Destination $target
        $addinFiles += "$($source.To)/$rel"
    }
}
if ($addinFiles -notcontains "word-addin/taskpane.html") { Fail "the Word add-in page was not found in word-addin/" }

# ---------- Pack ----------
# -C: change into the staging folder first, so paths in the archive are Dockerfile, not backend-staging/Dockerfile.
& $tar -cf $outFile -C $staging Dockerfile .dockerignore requirements.txt app
if ($LASTEXITCODE -ne 0) { Fail "tar.exe could not create the package" }
Remove-Item -Recurse -Force $staging

$entries = & $tar -tf $outFile
$files   = @($entries | Where-Object { $_ -notlike "*/" })
Write-Host "Packed: $outFile"
Write-Host ("Size  : {0:N0} bytes, {1} files" -f (Get-Item $outFile).Length, $files.Count)
Write-Host "Backend:"
$files | Where-Object { $_ -notlike "app/static/*" } | ForEach-Object { Write-Host "  $_" }
Write-Host ("Glossary admin page: {0} files" -f @($files | Where-Object { $_ -like "app/static/admin/*" }).Count)
Write-Host ("Word add-in pages  : {0} files (word-addin: {1}, shared with the browser extension: {2})" -f $addinFiles.Count, @($addinFiles | Where-Object { $_ -like "word-addin/*" }).Count, @($addinFiles | Where-Object { $_ -like "browser-extension/*" }).Count)
