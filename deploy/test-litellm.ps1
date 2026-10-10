# Sends one request to LiteLLM from your own computer and prints the reply, the token usage and the cost response headers.
#
# Usage (in PowerShell, from the repo root):
#   powershell -ExecutionPolicy Bypass -File deploy\test-litellm.ps1 -Server http://litellm-host:4000
#
# It asks for your key. The key is written to no file and does not stay in the command history.

param(
    # The LiteLLM address, e.g. http://10.0.0.5:4000
    [Parameter(Mandatory = $true)][string]$Server,
    # The model to call. It must already be added in the LiteLLM admin UI.
    [string]$Model = "langfAIx-model-1",
    [string]$Text = "Say hi in three words.",
    # Your LiteLLM virtual key. Better left empty: the script then asks for it.
    [string]$Key
)

if (-not $Key) { $Key = Read-Host "Paste your LiteLLM virtual key" }

# Request body in OpenAI-compatible format. No stream: streamed responses carry no cost header.
$body = @{
    model    = $Model
    messages = @(@{ role = "user"; content = $Text })
} | ConvertTo-Json -Depth 5

$url = $Server.TrimEnd('/') + "/v1/chat/completions"

try {
    $r = Invoke-WebRequest -Uri $url -Method Post -UseBasicParsing `
        -ContentType "application/json; charset=utf-8" `
        -Headers @{ Authorization = "Bearer $Key" } `
        -Body ([Text.Encoding]::UTF8.GetBytes($body))
}
catch {
    # On failure, show the error the server returned, to help find the cause.
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

$data = $r.Content | ConvertFrom-Json
$u = $data.usage

# Cached tokens. Some responses lack the field: treated as 0.
$cached = 0
if ($u.prompt_tokens_details -and $u.prompt_tokens_details.cached_tokens) {
    $cached = $u.prompt_tokens_details.cached_tokens
}

Write-Host "--- reply ---"
Write-Host $data.choices[0].message.content
Write-Host ""
Write-Host "--- usage (from response body) ---"
Write-Host ("prompt_tokens     : {0}" -f $u.prompt_tokens)
Write-Host ("  cached_tokens   : {0}" -f $cached)
Write-Host ("completion_tokens : {0}" -f $u.completion_tokens)
Write-Host ("total_tokens      : {0}" -f $u.total_tokens)
Write-Host ""
Write-Host "--- cost headers (from LiteLLM) ---"

# Only the response headers with cost, spend or budget in their name.
$found = 0
foreach ($name in ($r.Headers.Keys | Sort-Object)) {
    if ($name -match 'cost|spend|budget') {
        Write-Host ("{0,-42}: {1}" -f $name, ($r.Headers[$name] -join ', '))
        $found++
    }
}
if ($found -eq 0) { Write-Host "(none found)" -ForegroundColor Yellow }
