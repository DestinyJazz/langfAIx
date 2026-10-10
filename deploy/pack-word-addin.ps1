# Generates the Word add-in's manifest and makes the zip and install guide for users.
# Word reads the manifest to learn the add-in's name and where its pages are.
#
# The manifest must contain the server address, which belongs to a deployment and is not
# in the repo. The repo has a template (word-addin/manifest.template.xml); this script
# fills in the address and saves a copy.
#
# The add-in's pages are not handled here: they are packed with the backend
# (deploy/pack-backend.ps1), which serves them.
#
# Usage (in PowerShell, from the repo root):
#   powershell -ExecutionPolicy Bypass -File deploy/pack-word-addin.ps1 -ApiUrl https://your-server/api
# Without -ApiUrl the script asks.
#
# Output (all in deploy/build/):
#   langfaix-word-manifest.xml          the manifest
#   langfaix-word-addin-<version>.zip   for users: the manifest and the three install files
#   langfaix-word-install-guide.html    for users: the install guide
# Users unzip and double-click Install.cmd; the add-in is installed on their own computer
# (see deploy/install-word-addin.ps1). On your own computer, run
# deploy/install-word-addin.ps1 directly; no unzipping needed.

param(
    [string]$ApiUrl = ""
)

$ErrorActionPreference = "Stop"

$root     = Split-Path -Parent $PSScriptRoot
$addin    = Join-Path $root "word-addin"
$template = Join-Path $addin "manifest.template.xml"
$outDir   = Join-Path $PSScriptRoot "build"
$outFile  = Join-Path $outDir "langfaix-word-manifest.xml"
$guideTemplate = Join-Path $PSScriptRoot "word-install-guide.template.html"
$guideFile     = Join-Path $outDir "langfaix-word-install-guide.html"
$staging       = Join-Path $outDir "word-staging"   # staging folder: the files to ship are collected here, then zipped
# The system tar.exe (it writes zip too), by full path, so no other tar is picked up.
$tar           = "$env:SystemRoot/System32/tar.exe"
$utf8     = New-Object System.Text.UTF8Encoding($false)   # UTF-8 without BOM

function Fail($message) {
    Write-Host "PACK FAILED: $message" -ForegroundColor Red
    exit 1
}

# ---------- Server address ----------

if (-not $ApiUrl) {
    $ApiUrl = Read-Host "Server address (for example https://your-server.example.com/api)"
}
$ApiUrl = $ApiUrl.Trim().TrimEnd("/")
# Word only accepts https addresses.
if ($ApiUrl -notmatch '^https://[^\s/]+(/\S*)?$') {
    Fail "'$ApiUrl' is not an https address. It should look like https://your-server.example.com/api"
}
$uri      = [System.Uri]$ApiUrl
$origin   = $uri.GetLeftPart([System.UriPartial]::Authority)   # e.g. https://your-server.example.com
$addinUrl = "$ApiUrl/addin"

# ---------- Fill in the template ----------

$xml = [System.IO.File]::ReadAllText($template, $utf8)
# The template starts with a note for developers (an XML comment) that mentions the two markers. It is removed from the result.
$xml = ([regex]'(?s)<!--.*?-->\s*').Replace($xml, "", 1)
$xml = $xml.Replace("{{ORIGIN}}", $origin).Replace("{{ADDIN_URL}}", $addinUrl)
if ($xml.Contains("{{")) { Fail "a {{...}} mark in the manifest template was not filled in" }

# ---------- Checks ----------
# With the slightest fault in the manifest Word silently does not show the add-in. Whatever can be checked here is.

# 1. Well-formed XML
try { $doc = [xml]$xml } catch { Fail "the manifest is not valid XML: $($_.Exception.Message)" }

# An Office rule: the first part of the version must be at least 1 (Microsoft's validator rejects 0.1.0.0).
if ([int](([string]$doc.OfficeApp.Version).Split(".")[0]) -lt 1) { Fail "the manifest version must be 1.0 or higher, it is $($doc.OfficeApp.Version)" }

# 2. Every address pointing at our server has a matching file in the repo
$urls = [regex]::Matches($xml, 'DefaultValue="(https://[^"]+)"') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
foreach ($url in $urls) {
    if (-not $url.StartsWith("$addinUrl/word-addin/")) { Fail "the manifest points to $url, which is not under $addinUrl/word-addin/" }
    $rel = $url.Substring("$addinUrl/".Length)
    if (-not (Test-Path (Join-Path $root $rel))) { Fail "the manifest points to $rel, but there is no such file in the project" }
}

# 3. Everything referenced by resid is registered under Resources
$ids  = [regex]::Matches($xml, '\bid="([^"]+)"\s+DefaultValue=') | ForEach-Object { $_.Groups[1].Value }
$used = [regex]::Matches($xml, '\bresid="([^"]+)"') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
foreach ($name in $used) {
    if ($ids -notcontains $name) { Fail "the manifest uses resid '$name', which is not defined under Resources" }
}
# The popup's three strings are referenced by name from the page script and must be in the manifest.
foreach ($name in @("Popup.Title", "Popup.Subtitle", "Popup.Brand")) {
    if ($ids -notcontains $name) { Fail "the manifest is missing the string '$name' that the add-in uses for the popup" }
}
# An Office rule: resource names are at most 32 characters.
foreach ($name in $ids) {
    if ($name.Length -gt 32) { Fail "the resource id '$name' is longer than 32 characters" }
}

New-Item -ItemType Directory -Force -Path $outDir | Out-Null
[System.IO.File]::WriteAllText($outFile, $xml, $utf8)

Write-Host "Manifest: $outFile"
Write-Host "          add-in id $($doc.OfficeApp.Id), version $($doc.OfficeApp.Version)"
Write-Host "          page    : $($doc.OfficeApp.DefaultSettings.SourceLocation.DefaultValue)"

# ---------- The zip for users ----------
# Four files at the top level: the manifest, the install script, and Install.cmd and
# Uninstall.cmd for double-clicking. The install script looks for
# langfaix-word-manifest.xml next to itself, so the four must stay together.

$version = [string]$doc.OfficeApp.Version
$zipName = "langfaix-word-addin-$version.zip"
$zip     = Join-Path $outDir $zipName
$parts   = @(
    $outFile,
    (Join-Path $PSScriptRoot "install-word-addin.ps1"),
    (Join-Path $PSScriptRoot "word-install\Install.cmd"),
    (Join-Path $PSScriptRoot "word-install\Uninstall.cmd")
)
foreach ($part in $parts) {
    if (-not (Test-Path $part)) { Fail "'$part' is missing, it belongs in the package" }
}
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
New-Item -ItemType Directory -Force -Path $staging | Out-Null
foreach ($part in $parts) { Copy-Item -Path $part -Destination $staging }
# Delete zips of earlier versions, so the wrong one is not handed out.
Get-ChildItem -Path $outDir -Filter "langfaix-word-addin-*.zip" | Remove-Item -Force
$names = $parts | ForEach-Object { Split-Path -Leaf $_ }
& $tar -a -cf $zip -C $staging @names
if ($LASTEXITCODE -ne 0) { Fail "tar.exe could not create the zip" }
Remove-Item -Recurse -Force $staging
# Look at what is really in the zip.
$entries = & $tar -tf $zip
foreach ($name in $names) {
    if ($entries -notcontains $name) { Fail "$name is not at the top of the zip" }
}
Write-Host "Package : $zip"
Write-Host ("          " + ($names -join ", "))

# ---------- Install guide ----------

$html = [System.IO.File]::ReadAllText($guideTemplate, $utf8)
# The template starts with a note for developers (an HTML comment); it is removed from the copy for users.
$html = ([regex]'(?s)\s*<!--.*?-->').Replace($html, "", 1)
$html = $html.Replace("{{VERSION}}", $version).Replace("{{ZIP}}", $zipName)
if ($html.Contains("{{")) { Fail "a {{...}} mark in the Word install guide template was not filled in" }
[System.IO.File]::WriteAllText($guideFile, $html, $utf8)
Write-Host "Guide   : $guideFile"
Write-Host "Send the package and the guide together."
Write-Host "The page itself is served by the backend: upload deploy/build/langfaix-backend.tar first."
