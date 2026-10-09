# Copies the BMU Hub database from the local PostgreSQL 17 (localhost:5432, bmu_hub) into a Supabase project.
#
# Before running:
#   1. Create a project at supabase.com (pick the region closest to your users, e.g. Mumbai) and note its database password.
#   2. In the project: Connect (top bar) > Connection String > Method: "Session pooler". Copy that URI.
# Then, in the project folder (no Administrator needed):
#   powershell -ExecutionPolicy Bypass -File scripts\migrate-to-supabase.ps1
#
# The local database is only read. The Supabase database must not already contain the BMU Hub tables.
# At the end it prints the DATABASE_URL line to put in apps/api/.env.

$ErrorActionPreference = 'Stop'
$bin = 'C:\Program Files\PostgreSQL\17\bin'
$psql = Join-Path $bin 'psql.exe'
$pgDump = Join-Path $bin 'pg_dump.exe'
$work = Join-Path $env:TEMP "bmu-supabase-$(Get-Date -Format yyyyMMddHHmmss)"

function Say($msg) { Write-Host "[bmu] $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "[bmu] $msg" -ForegroundColor Red; exit 1 }
function Plain($secure) { [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)) }

# Connection details travel as separate psql arguments plus PGPASSWORD, so passwords with symbols need no escaping.
$local = @{ Host = 'localhost'; Port = '5432'; User = 'bmu'; Db = 'bmu_hub'; Password = ''; Ssl = 'prefer' }
$remote = @{ Host = ''; Port = ''; User = ''; Db = ''; Password = ''; Ssl = 'require' }

# Runs SQL through psql (via a file: Windows PowerShell mangles double quotes such as "User" in program arguments).
function Invoke-Sql($c, $sql) {
  $f = Join-Path $work 'query.sql'
  [IO.File]::WriteAllText($f, $sql, (New-Object Text.UTF8Encoding $false))
  $env:PGPASSWORD = $c.Password; $env:PGSSLMODE = $c.Ssl
  try {
    $out = & $psql -X -q -A -t -v ON_ERROR_STOP=1 -h $c.Host -p $c.Port -U $c.User -d $c.Db -f $f
    if ($LASTEXITCODE) { throw "psql failed on $($c.Host)" }
    $out
  } finally { Remove-Item Env:PGPASSWORD, Env:PGSSLMODE -ErrorAction SilentlyContinue }
}

# --- Details -------------------------------------------------------------------------------------
if (-not (Test-Path $pgDump)) { Fail "PostgreSQL 17 tools not found in $bin." }
New-Item -ItemType Directory -Force $work | Out-Null
$env:PGCLIENTENCODING = 'UTF8'

$p = Plain (Read-Host 'Local bmu password (press Enter for the default "bmu")' -AsSecureString)
$local.Password = if ($p) { $p } else { 'bmu' }

$uriText = (Read-Host 'Paste the Supabase "Session pooler" connection string').Trim()
# Parsed by hand: Supabase's string contains "[YOUR-PASSWORD]", which [Uri] rejects. The password part is ignored.
$m = [regex]::Match($uriText, '^postgres(?:ql)?://([^:@/]+)(?::[^@]*)?@([^:/?]+)(?::(\d+))?(?:/([^?]*))?')
if (-not $m.Success) { Fail 'That does not look like a connection string (it should start with postgresql://).' }
$remote.User = [Uri]::UnescapeDataString($m.Groups[1].Value)
$remote.Host = $m.Groups[2].Value
$remote.Port = if ($m.Groups[3].Value) { $m.Groups[3].Value } else { '5432' }
$remote.Db = if ($m.Groups[4].Value) { $m.Groups[4].Value } else { 'postgres' }
if ($remote.Port -eq '6543') { Fail 'That is the Transaction pooler (port 6543). Choose "Session pooler" (port 5432) in Supabase > Connect.' }
$remote.Password = Plain (Read-Host 'Supabase database password' -AsSecureString)
if (-not $remote.Password) { Fail 'The Supabase database password is required.' }

$failed = $false
try {
  # --- Checks ------------------------------------------------------------------------------------
  Say 'Checking the local database...'
  # pnpm dev starts the old private database (PostgreSQL 18, .bmu-data) on the same port when PostgreSQL 17 is down.
  $localVersion = Invoke-Sql $local 'show server_version_num'
  if ([int]$localVersion -lt 170000 -or [int]$localVersion -ge 180000) {
    throw "localhost:5432 is PostgreSQL $([math]::Floor([int]$localVersion / 10000)), not your PostgreSQL 17. Stop pnpm dev (Ctrl+C), start the postgresql-x64-17 service (Administrator), then run this again."
  }
  $tables = @(Invoke-Sql $local "select tablename from pg_tables where schemaname = 'public' order by 1")
  if (-not $tables.Count) { throw 'The local bmu_hub database has no tables.' }

  Say "Connecting to Supabase ($($remote.Host))..."
  $version = Invoke-Sql $remote 'show server_version'
  Say "Supabase PostgreSQL $version"
  $clash = Invoke-Sql $remote "select count(*) from pg_tables where schemaname = 'public' and tablename in ('_prisma_migrations', 'users', 'organisations')"
  if ([int]$clash -gt 0) { throw 'This Supabase database already has BMU Hub tables. Nothing was changed. Use a fresh project, or drop those tables first.' }

  # --- Copy --------------------------------------------------------------------------------------
  Say 'Exporting the local database...'
  $dump = Join-Path $work 'bmu_hub.sql'
  $env:PGPASSWORD = $local.Password
  & $pgDump -h $local.Host -p $local.Port -U $local.User -d $local.Db --schema=public --no-owner --no-privileges --no-comments -f $dump
  $code = $LASTEXITCODE
  Remove-Item Env:PGPASSWORD
  if ($code) { throw 'pg_dump failed.' }
  # Supabase's public schema already exists and belongs to Supabase; drop statements that would touch it,
  # and settings older Supabase servers (PostgreSQL 15) do not know.
  $lines = Get-Content $dump -Encoding UTF8 | Where-Object { $_ -notmatch '^(CREATE SCHEMA public;|SET transaction_timeout)' }
  [IO.File]::WriteAllLines($dump, $lines, (New-Object Text.UTF8Encoding $false))

  Say "Loading $($tables.Count) tables into Supabase (a few minutes on a slow connection)..."
  $env:PGPASSWORD = $remote.Password; $env:PGSSLMODE = 'require'
  & $psql -X -q -v ON_ERROR_STOP=1 -1 -h $remote.Host -p $remote.Port -U $remote.User -d $remote.Db -f $dump | Out-Null
  $code = $LASTEXITCODE
  Remove-Item Env:PGPASSWORD, Env:PGSSLMODE
  if ($code) { throw 'Loading into Supabase failed (nothing was kept: it runs as one transaction). See the error above.' }

  # --- Check -------------------------------------------------------------------------------------
  Say 'Comparing row counts...'
  $bad = @()
  foreach ($t in $tables) {
    $a = Invoke-Sql $local "select count(*) from public.`"$t`""
    $b = Invoke-Sql $remote "select count(*) from public.`"$t`""
    if ($a -ne $b) { $bad += "$t (local $a, Supabase $b)" }
  }
  if ($bad.Count) { throw "Row counts differ: $($bad -join '; ')" }

  # Supabase publishes the public schema through its web API (roles anon / authenticated, reachable with the
  # project's public key). BMU Hub never uses that API, so shut it out: no grants, and row level security on
  # with no policies. The app connects as the table owner, which RLS does not restrict.
  Say 'Closing Supabase web API access to the CRM tables...'
  Invoke-Sql $remote @"
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from anon, authenticated;
do `$`$ declare t record; begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t.tablename);
  end loop;
end `$`$;
"@ | Out-Null
  Invoke-Sql $remote 'ANALYZE' | Out-Null
  Say "All $($tables.Count) tables copied and row counts match."
}
catch {
  Write-Host "[bmu] $($_.Exception.Message)" -ForegroundColor Red
  $failed = $true
}
finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
if ($failed) { exit 1 }

$enc = [Uri]::EscapeDataString($remote.Password)
$url = "postgresql://$([Uri]::EscapeDataString($remote.User)):$enc@$($remote.Host):$($remote.Port)/$($remote.Db)?sslmode=require"
Write-Host ''
Say 'Done. To make BMU Hub use Supabase, put this line in apps\api\.env in place of the current DATABASE_URL:'
Write-Host ''
Write-Host "DATABASE_URL=`"$url`"" -ForegroundColor Yellow
Write-Host 'DATABASE_POOL_MAX=5' -ForegroundColor Yellow
Write-Host ''
Say 'DATABASE_POOL_MAX=5 keeps BMU Hub inside the free pooler limit (about 15 connections).'
Say 'Then restart pnpm dev. Your local PostgreSQL 17 copy is unchanged (keep it as a backup).'
