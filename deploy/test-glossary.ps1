# After deploying: walks the whole glossary path from your own computer, to confirm it works on the real Postgres and the real LiteLLM.
#
# What it does:
#   1. asks the backend whether the database is connected
#   2. asks LiteLLM directly whether your key can look itself up (a key that may only call
#      models cannot, which is normal)
#   3. asks the backend who you are and what role you have
#   4. if you can edit: adds a test term and confirms it takes effect at once in checks
#      (the term is no longer a misspelling, its wrong form is flagged, its Chinese in
#      English text is flagged), then looks it up, changes it, exports, and deletes it
#   5. prints PASS or FAIL
#
# Usage (in PowerShell, from the repo root):
#   powershell -ExecutionPolicy Bypass -File deploy/test-glossary.ps1 -Api https://your-server/api -LiteLLM https://your-litellm-server
#
# It asks for your LiteLLM virtual key. The key is written to no file and does not appear
# in the output. No AI is called; nothing is spent.

param(
    # The backend address, e.g. https://your-server/api
    [Parameter(Mandatory = $true)][string]$Api,
    # The LiteLLM address. Only used to see what it answers for your key, which helps when something fails.
    [Parameter(Mandatory = $true)][string]$LiteLLM,
    # Your LiteLLM virtual key. Better left empty: the script then asks for it.
    [string]$Key
)

if (-not $Key) { $Key = Read-Host "Paste your LiteLLM virtual key" }
$Api = $Api.TrimEnd('/')
$LiteLLM = $LiteLLM.TrimEnd('/')
$script:headers = @{ Authorization = "Bearer $Key" }
$script:failed = 0

# The test term: an odd English word that cannot clash with a real term, and an equally odd Chinese one.
$testEn = "Zzglossarytest"
$testWrong = "Zz glossary test"
$testZh = "术语表自测词"

# Send a request. Always returns @{ Status; Text; Json } and never throws, so callers judge uniformly.
function Invoke-Api([string]$Method, [string]$Url, $Body = $null, [switch]$NoKey) {
    $params = @{ Uri = $Url; Method = $Method; UseBasicParsing = $true }
    if (-not $NoKey) { $params.Headers = $script:headers }
    if ($null -ne $Body) {
        $params.ContentType = "application/json; charset=utf-8"
        # Chinese must go out as UTF-8, so convert to bytes here.
        $params.Body = [Text.Encoding]::UTF8.GetBytes(($Body | ConvertTo-Json -Depth 6))
    }
    $status = 0
    $text = ""
    try {
        $r = Invoke-WebRequest @params
        $status = [int]$r.StatusCode
        # The response is UTF-8. Windows PowerShell 5.1 would read it in another encoding and garble Chinese, so decode it here.
        $text = [Text.Encoding]::UTF8.GetString($r.RawContentStream.ToArray())
    }
    catch {
        $response = $_.Exception.Response
        if ($response) {
            $status = [int]$response.StatusCode
            # The error text is sometimes in ErrorDetails and sometimes has to be read from the response.
            if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
                $text = $_.ErrorDetails.Message
            } else {
                try {
                    $reader = New-Object IO.StreamReader($response.GetResponseStream(), [Text.Encoding]::UTF8)
                    $text = $reader.ReadToEnd()
                } catch { }
            }
        } else {
            $text = $_.Exception.Message
        }
    }
    $json = $null
    if ($text) { try { $json = $text | ConvertFrom-Json } catch { } }
    return @{ Status = $status; Text = $text; Json = $json }
}

# Record the result of one check.
function Check([string]$Name, [bool]$Ok, [string]$Detail = "") {
    if ($Ok) {
        Write-Host ("ok    {0,-44} {1}" -f $Name, $Detail)
    } else {
        Write-Host ("FAIL  {0,-44} {1}" -f $Name, $Detail) -ForegroundColor Red
        $script:failed++
    }
}

function Finish() {
    Write-Host ""
    if ($script:failed -eq 0) { Write-Host "RESULT: PASS" -ForegroundColor Green; exit 0 }
    Write-Host "RESULT: FAIL ($($script:failed) problem(s)). The output above contains no secrets and can be attached to a bug report." -ForegroundColor Red
    exit 1
}

# ---------- 1. Backend and database ----------

Write-Host "1. Backend" -ForegroundColor Cyan
$health = Invoke-Api GET "$Api/healthz" -NoKey
Check "backend answers" ($health.Status -eq 200) "HTTP $($health.Status)"
if ($health.Status -ne 200) { Write-Host $health.Text; Finish }
$storage = $health.Json.glossary_storage
Check "glossary database connected" ($storage -eq "ok") "storage: $storage, rows: $($health.Json.glossary_terms)"
if ($null -eq $storage) {
    Write-Host "      The backend does not report glossary_storage: it is still the old image. Build the new image and update the stack." -ForegroundColor Yellow
    Finish
}

# ---------- 2. What LiteLLM says about this key ----------

Write-Host ""
Write-Host "2. What LiteLLM says about your key (no secrets are printed)" -ForegroundColor Cyan
$info = Invoke-Api GET "$LiteLLM/key/info"
if ($info.Status -eq 200 -and $info.Json) {
    $i = $info.Json
    if ($info.Json.info) { $i = $info.Json.info }
    Write-Host ("      fields    : " + (($i.PSObject.Properties.Name | Sort-Object) -join ", "))
    Write-Host ("      key_alias : " + $i.key_alias)
    Write-Host ("      status    : " + $i.status + "   blocked: " + $i.blocked)
    Write-Host ("      user_id   : " + $i.user_id + "   team_id: " + $i.team_id)
    # Also look at the user the key belongs to and that user's role. A LiteLLM admin role
    # means the key can do far more than call models, which deserves attention.
    $user = Invoke-Api GET "$LiteLLM/user/info"
    if ($user.Status -eq 200 -and $user.Json.user_info) {
        $role = $user.Json.user_info.user_role
        Write-Host ("      user_role : " + $role)
        if ($role -eq "proxy_admin") {
            Write-Host "      NOTE: this key belongs to a LiteLLM administrator. It can do far more than call models." -ForegroundColor Yellow
        }
    } else {
        Write-Host ("      user_role : could not be read (HTTP " + $user.Status + ")")
    }
} elseif ($info.Status -eq 403) {
    # This is normal: a key handed to users may only call models and cannot look itself up.
    # The backend does not rely on that; it asks with its own admin key. So this is not a
    # failure; step 3 decides.
    Write-Host "      Your key may only call the model, so it cannot look itself up (LiteLLM said HTTP 403)."
    Write-Host "      That is the right setting for a user key. The backend looks it up with its own key instead."
} else {
    Write-Host ("      LiteLLM answered HTTP " + $info.Status + ": " + $info.Text) -ForegroundColor Yellow
}

# ---------- 3. Does the backend know you ----------

Write-Host ""
Write-Host "3. Who the backend thinks you are" -ForegroundColor Cyan
$me = Invoke-Api GET "$Api/glossary/me"
Check "signed in" ($me.Status -eq 200) "HTTP $($me.Status) $(if ($me.Status -ne 200) { $me.Text })"
if ($me.Status -ne 200) { Finish }
Write-Host ("      alias: " + $me.Json.alias + "   id: " + $me.Json.id + "   role: " + $me.Json.role)

if (-not $me.Json.can_edit) {
    Write-Host ""
    Write-Host "You are a viewer, so the rest of the test (adding a term) cannot run." -ForegroundColor Yellow
    Write-Host "To become the first administrator: set the GLOSSARY_ADMINS variable of the backend to" -ForegroundColor Yellow
    Write-Host ("    " + $me.Json.alias) -ForegroundColor Yellow
    Write-Host ("(or to your id, " + $me.Json.id + "), update the stack, and run this script again.") -ForegroundColor Yellow
    $script:failed++
    Finish
}

# ---------- 4. Add a test term and see whether it takes effect at once ----------

Write-Host ""
Write-Host "4. A test term, from adding it to deleting it" -ForegroundColor Cyan

# An interrupted earlier run may have left the test term behind. Remove it first.
$all = Invoke-Api GET "$Api/glossary/terms"
Check "list terms" ($all.Status -eq 200) "HTTP $($all.Status), $(@($all.Json.terms).Count) rows"
foreach ($old in @($all.Json.terms | Where-Object { $_.en -eq $testEn })) {
    [void](Invoke-Api DELETE "$Api/glossary/terms/$($old.id)")
}

$body = @{ en = $testEn; zh = $testZh; category = "Other"; variants = @($testWrong); note = "created by test-glossary.ps1, safe to delete" }
$created = Invoke-Api POST "$Api/glossary/terms" $body
Check "add a term" ($created.Status -eq 201) "HTTP $($created.Status) $(if ($created.Status -ne 201) { $created.Text })"
if ($created.Status -ne 201) { Finish }
$id = $created.Json.id
Check "Chinese is stored correctly" ($created.Json.zh -eq $testZh) $created.Json.zh

try {
    # Check a sentence containing the term, its wrong form and its Chinese.
    $sentence = "Open the $testEn page, not the $testWrong page, then click $testZh to continue."
    $checked = Invoke-Api POST "$Api/check" @{ text = $sentence } -NoKey
    Check "check a sentence" ($checked.Status -eq 200) "HTTP $($checked.Status)"
    $found = @($checked.Json.matches)
    $texts = @($found | ForEach-Object { $_.text })
    Check "the term is not flagged" (-not ($texts -contains $testEn)) ("flagged: " + ($texts -join " | "))
    $wrong = @($found | Where-Object { $_.rule_id -eq "GLOSSARY_TERM" -and $_.text -eq $testWrong })
    Check "the wrong form is flagged" ($wrong.Count -eq 1 -and $wrong[0].replacements[0] -eq $testEn) "suggestion: $($wrong[0].replacements -join ', ')"
    $chinese = @($found | Where-Object { $_.rule_id -eq "GLOSSARY_TERM" -and $_.text -eq $testZh })
    Check "Chinese inside English is flagged" ($chinese.Count -eq 1 -and $chinese[0].replacements[0] -eq $testEn) "suggestion: $($chinese[0].replacements -join ', ')"

    # Look up by Chinese. Chinese in a URL must be encoded first.
    $looked = Invoke-Api GET ("$Api/glossary/lookup?q=" + [Uri]::EscapeDataString($testZh))
    Check "look up by Chinese" ($looked.Status -eq 200 -and @($looked.Json.results | Where-Object { $_.en -eq $testEn }).Count -eq 1) "HTTP $($looked.Status)"

    $body.note = "changed by test-glossary.ps1"
    $changed = Invoke-Api PUT "$Api/glossary/terms/$id" $body
    Check "change the term" ($changed.Status -eq 200 -and $changed.Json.note -eq $body.note) "HTTP $($changed.Status)"

    $exported = Invoke-Api GET "$Api/glossary/export?format=csv"
    Check "export" ($exported.Status -eq 200 -and $exported.Text.Contains($testEn) -and $exported.Text.Contains($testZh)) "HTTP $($exported.Status), $($exported.Text.Length) characters"
}
finally {
    # Whatever failed above, the test term is deleted and never stays in the real glossary.
    $deleted = Invoke-Api DELETE "$Api/glossary/terms/$id"
    Check "delete the test term" ($deleted.Status -eq 204) "HTTP $($deleted.Status)"
}

$after = Invoke-Api GET "$Api/glossary/lookup?q=$testEn"
Check "the test term is gone" ($after.Status -eq 200 -and @($after.Json.results).Count -eq 0) "HTTP $($after.Status)"

Finish
