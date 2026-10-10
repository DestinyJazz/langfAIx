# Packs the browser extension into a zip for users, and generates an install guide with the server address filled in.
#
# Why pack instead of handing out the browser-extension folder: it also holds
# development-only files (unit tests, a package.json for Node.js, the icon script) that
# users do not need and that should not be in the extension they load.
#
# Usage (in PowerShell, from the repo root):
#   powershell -ExecutionPolicy Bypass -File deploy/pack-extension.ps1 -ApiUrl https://your-server/api
# Without -ApiUrl the script asks. The address only goes into the install guide; the
# extension itself contains no address.
#
# Output (both in deploy/build/; hand them out together):
#   langfaix-extension-<version>.zip
#   langfaix-extension-install-guide.html
#
# Afterwards, a browser can really install the zip as a check:
#   cd e2e, then npm run packed -- https://your-server/api

param(
    [string]$ApiUrl = ""
)

$ErrorActionPreference = "Stop"

$root     = Split-Path -Parent $PSScriptRoot       # repo root
$source   = Join-Path $root "browser-extension"
$outDir   = Join-Path $PSScriptRoot "build"
$staging  = Join-Path $outDir "extension-staging"   # staging folder: the files to ship are collected here, then zipped
$template = Join-Path $PSScriptRoot "extension-install-guide.template.html"
$guide    = Join-Path $outDir "langfaix-extension-install-guide.html"
# The system tar.exe (it writes zip too), by full path, so no other tar is picked up.
$tar      = "$env:SystemRoot/System32/tar.exe"
$utf8     = New-Object System.Text.UTF8Encoding($false)   # UTF-8 without BOM

function Fail($message) {
    Write-Host "PACK FAILED: $message" -ForegroundColor Red
    exit 1
}

# ---------- Server address (for the install guide) ----------

if (-not $ApiUrl) {
    $ApiUrl = Read-Host "Server address to print in the install guide (for example https://your-server.example.com/api)"
}
$ApiUrl = $ApiUrl.Trim().TrimEnd("/")
if ($ApiUrl -notmatch '^https?://[^\s/]+(/\S*)?$') {
    Fail "'$ApiUrl' does not look like a server address. It should look like https://your-server.example.com/api"
}
if ($ApiUrl -notmatch '/api$') {
    Write-Host "Note: the address does not end with /api. Check that it is the one colleagues should type." -ForegroundColor Yellow
}

# ---------- Select the files to ship ----------

# Development-only files, not shipped. Paths relative to browser-extension, forward slashes, * matches anything.
$devOnly = @(
    "tests/*",              # unit tests
    "node_modules/*",
    "package.json",         # only tells Node.js that the .js files are ES modules; browsers ignore it
    "package-lock.json",
    "icons/make_icons.py",  # draws the icons; the icons themselves are .png
    "icons/__pycache__/*"   # Python's cache after running that script
)
# File types the extension uses at run time, besides manifest.json.
$shipTypes = @(".js", ".html", ".css", ".png")

$ship    = @()
$left    = @()
$unknown = @()
foreach ($file in Get-ChildItem -Path $source -Recurse -File) {
    $rel = $file.FullName.Substring($source.Length + 1).Replace("\", "/")
    if ($devOnly | Where-Object { $rel -like $_ }) { $left += $rel }
    elseif ($rel -eq "manifest.json" -or $shipTypes -contains $file.Extension.ToLower()) { $ship += $rel }
    else { $unknown += $rel }
}
# Stop at any unknown file instead of deciding for the user. Nothing unidentified should be shipped.
if ($unknown.Count -gt 0) {
    Fail ("these files are neither listed as development-only nor of a known type: " + ($unknown -join ", ") + ". Decide whether colleagues need them, then add them to `$devOnly or `$shipTypes in this script.")
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
foreach ($rel in $ship) {
    $target = Join-Path $staging $rel
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    Copy-Item -Path (Join-Path $source $rel) -Destination $target
}

# ---------- Check that the selection is complete ----------
# The rules above might exclude a file needed at run time, which would only show after a user installs it.

$manifest = [System.IO.File]::ReadAllText((Join-Path $staging "manifest.json"), $utf8) | ConvertFrom-Json
$version  = $manifest.version
if ($version -notmatch '^\d+(\.\d+){1,3}$') { Fail "manifest.json has an unusual version: '$version'" }

# 1. Every file named in manifest.json is there
$named = @($manifest.background.service_worker, $manifest.action.default_popup, $manifest.options_page)
$named += $manifest.icons.PSObject.Properties | ForEach-Object { $_.Value }
foreach ($entry in $manifest.content_scripts) { $named += $entry.js; $named += $entry.css }
foreach ($rel in $named) {
    if ($rel -and -not (Test-Path (Join-Path $staging $rel))) { Fail "manifest.json refers to '$rel', which is not in the package" }
}

# 2. Every file a .js imports and every file an .html references is there
foreach ($rel in $ship) {
    $path = Join-Path $staging $rel
    if ($rel -like "*.js") {
        $pattern = '(?m)^\s*(?:import|export)\b[^;]*?\bfrom\s+["'']([.]{1,2}/[^"'']+)["'']'
    } elseif ($rel -like "*.html") {
        # Relative addresses only: those with a colon (https:, chrome:) or starting with # are skipped
        $pattern = '\b(?:src|href)\s*=\s*"([^"#:]+)"'
    } else { continue }
    $text = [System.IO.File]::ReadAllText($path, $utf8)
    foreach ($match in [regex]::Matches($text, $pattern)) {
        $wanted = $match.Groups[1].Value
        $target = [System.IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $path) $wanted))
        if (-not (Test-Path $target)) { Fail "'$rel' refers to '$wanted', which is not in the package" }
    }
}

# ---------- Zip ----------

# Delete earlier zips (other versions too), so the wrong one is not handed out.
Get-ChildItem -Path $outDir -Filter "langfaix-extension-*.zip" | Remove-Item
$zip = Join-Path $outDir "langfaix-extension-$version.zip"

# -a: pick the format from the file extension, so .zip gives a zip.
# -C: change into the staging folder first, so manifest.json is at the top of the zip. The
# unpacked folder can then be loaded directly with Load unpacked, and a store upload requires the same.
$top = Get-ChildItem -Path $staging | ForEach-Object { $_.Name }
& $tar -a -cf $zip -C $staging @top
if ($LASTEXITCODE -ne 0) { Fail "tar.exe could not create the zip" }

# Look at what is really in the zip.
$entries = & $tar -tf $zip
if ($entries -notcontains "manifest.json") { Fail "manifest.json is not at the top of the zip" }
$stray = $entries | Where-Object { $_ -like "tests/*" -or $_ -like "*package.json" -or $_ -like "*.py" -or $_ -like "*node_modules*" }
if ($stray) { Fail ("development-only files ended up in the zip: " + ($stray -join ", ")) }

Remove-Item -Recurse -Force $staging

# ---------- Install guide ----------

function Escape($text) {
    return $text.Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace('"', "&quot;")
}

$html = [System.IO.File]::ReadAllText($template, $utf8)
# The template starts with a note for developers (an HTML comment); it is removed from the copy for users.
$html = ([regex]'(?s)\s*<!--.*?-->').Replace($html, "", 1)
$html = $html.Replace("{{VERSION}}", (Escape $version))
$html = $html.Replace("{{API_URL}}", (Escape $ApiUrl))
$html = $html.Replace("{{ADMIN_URL}}", (Escape "$ApiUrl/admin/"))
# The server's host name: users who limit the extension to specific sites must add it to that list, or the extension cannot reach the server.
$html = $html.Replace("{{API_HOST}}", (Escape ([System.Uri]$ApiUrl).Host))
if ($html.Contains("{{")) { Fail "a {{...}} mark in the install guide template was not filled in" }
[System.IO.File]::WriteAllText($guide, $html, $utf8)

# ---------- Result ----------

$files = @($entries | Where-Object { $_ -notlike "*/" })
Write-Host "Packed : $zip"
Write-Host ("         version $version, {0} files, {1:N0} bytes" -f $files.Count, (Get-Item $zip).Length)
Write-Host "Guide  : $guide"
Write-Host "         server address in the guide: $ApiUrl"
# What was left out: tests are many, so only their count; the rest one by one.
$inTests = @($left | Where-Object { $_ -like "tests/*" })
$others  = @($left | Where-Object { $_ -notlike "tests/*" })
Write-Host ("Left out (development only): tests/ ({0} files), {1}" -f $inTests.Count, ($others -join ", "))
Write-Host "Send the zip and the guide to your colleagues."
