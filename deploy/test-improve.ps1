# Calls the backend's AI rewrite endpoint (/ai/improve) from your own computer and prints the result as cost cards:
# one card per sentence with the edits, token usage and cost. Sentences without edits are shown too (they cost money as well).
#
# Usage (in PowerShell, from the repo root):
#   powershell -ExecutionPolicy Bypass -File deploy/test-improve.ps1 -Api https://your-server/api
#
# It asks for your LiteLLM virtual key. The key is written to no file and does not appear
# in the output. Every run really calls the model; the default three sentences cost
# about US$0.001 with a small model.

param(
    # The backend address, e.g. https://your-server/api
    [Parameter(Mandatory = $true)][string]$Api,
    # The text to check. By default three deliberately wrong sentences.
    [string]$Text = "This feature support user authentication in conjunction with LDAP server. Earlier versions do not support this feature. Please refer to the the configuration guide for more informations.",
    # Your LiteLLM virtual key. Better left empty: the script then asks for it.
    [string]$Key
)

if (-not $Key) { $Key = Read-Host "Paste your LiteLLM virtual key" }

$body = @{ text = $Text } | ConvertTo-Json
$url  = $Api.TrimEnd('/') + "/ai/improve"

try {
    $r = Invoke-WebRequest -Uri $url -Method Post -UseBasicParsing `
        -ContentType "application/json; charset=utf-8" `
        -Headers @{ Authorization = "Bearer $Key" } `
        -Body ([Text.Encoding]::UTF8.GetBytes($body))
}
catch {
    Write-Host "REQUEST FAILED: $($_.Exception.Message)" -ForegroundColor Red
    $msg = $_.ErrorDetails.Message
    if (-not $msg -and $_.Exception.Response) {
        try {
            $reader = New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())
            $msg = $reader.ReadToEnd()
        } catch { }
    }
    if ($msg) { Write-Host $msg }
    exit 1
}

# The response is UTF-8. Windows PowerShell 5.1 would read it in another encoding and
# garble quotes in the reasons, so decode it here.
$json = [Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
$data = $json | ConvertFrom-Json

# One line with a sentence's token usage and cost.
function Format-Cost($s) {
    if (-not $s.usage) { return "no usage reported" }
    $u = $s.usage
    $line = "{0} tokens (in {1}, cached {2} / out {3})" -f $u.total_tokens, $u.prompt_tokens, $u.cached_tokens, $u.completion_tokens
    if ($s.cost -and $s.cost.self_hosted) { return "$line | self-hosted model, no charge" }
    if ($s.cost -and $null -ne $s.cost.usd) {
        $line += " | US`${0:N6}" -f $s.cost.usd
        if ($null -ne $s.cost.litellm_usd) { $line += "  (LiteLLM says US`${0:N6})" -f $s.cost.litellm_usd }
    } else {
        $line += " | cost unknown"
    }
    return $line
}

Write-Host ""
Write-Host ("Model: {0}" -f $data.model)
Write-Host ""

$totalUsd = 0.0
foreach ($s in $data.sentences) {
    if ($s.status -eq "changed") {
        Write-Host ("[EDIT]  {0}" -f $s.text) -ForegroundColor Yellow
        foreach ($e in $s.edits) {
            Write-Host ('        "{0}"  ->  "{1}"' -f $e.original, $e.replacement)
            Write-Host ("        Reason: {0}" -f $e.reason)
        }
    }
    elseif ($s.status -eq "unchanged") {
        Write-Host ("[OK]    {0}" -f $s.text) -ForegroundColor Green
        Write-Host "        AI checked, no change needed"
    }
    else {
        Write-Host ("[ERROR] {0}" -f $s.text) -ForegroundColor Red
        Write-Host ("        {0}" -f $s.error)
    }
    if ($s.dropped_edits -gt 0) { Write-Host ("        ({0} suggestion(s) dropped: could not be located in the sentence)" -f $s.dropped_edits) }
    Write-Host ("        {0}" -f (Format-Cost $s)) -ForegroundColor DarkGray
    Write-Host ""
    if ($s.cost -and $null -ne $s.cost.usd) { $totalUsd += $s.cost.usd }
}

# This total is only a convenience for this test run, not a product feature.
Write-Host ("{0} sentence(s), total US`${1:N6} for this test run" -f $data.sentences.Count, $totalUsd)
