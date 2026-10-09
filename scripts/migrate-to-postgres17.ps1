# Moves the BMU Hub database from the private dev database (.bmu-data, started by `pnpm dev`)
# into the PostgreSQL 17 Windows service installed on this machine.
#
# Before running:  stop `pnpm dev` (Ctrl+C) so the private database is shut down.
# Run from an Administrator PowerShell, in the project folder:
#   powershell -ExecutionPolicy Bypass -File scripts\migrate-to-postgres17.ps1
#
# What it does:
#   1. Starts the private database on port 5433 (read-only use: it is only copied from).
#   2. Lets local connections into PostgreSQL 17 without a password for the duration of the
#      script (pg_hba.conf is backed up and put back at the end, even if something fails).
#   3. Creates user bmu (password bmu) and database bmu_hub, matching apps/api/.env.
#   4. Builds the tables with the app's Prisma migrations, then copies every row across.
#   5. Compares row counts table by table.
# Afterwards `pnpm dev` finds PostgreSQL 17 on port 5432 and uses it; .bmu-data is left untouched.

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$pg17 = 'C:\Program Files\PostgreSQL\17'
$pg17Bin = Join-Path $pg17 'bin'
$pg17Data = Join-Path $pg17 'data'
$service = 'postgresql-x64-17'
$embeddedBin = Get-ChildItem (Join-Path $root 'node_modules\.pnpm') -Directory -Filter '@embedded-postgres+windows-x64@*' |
  ForEach-Object { Join-Path $_.FullName 'node_modules\@embedded-postgres\windows-x64\native\bin' } | Select-Object -First 1
$embeddedData = Join-Path $root '.bmu-data\postgres'
$psql = Join-Path $pg17Bin 'psql.exe'
$work = Join-Path $env:TEMP "bmu-migration-$(Get-Date -Format yyyyMMddHHmmss)"
$hba = Join-Path $pg17Data 'pg_hba.conf'
$hbaBackup = "$hba.before-bmu-migration"

function Say($msg) { Write-Host "[bmu] $msg" -ForegroundColor Green }
function Fail($msg) { Write-Host "[bmu] $msg" -ForegroundColor Red; exit 1 }
# Runs SQL through psql and returns its output; stops the script if it fails. The SQL goes via a file
# because Windows PowerShell mangles double quotes in program arguments ("User", "orgId", ...).
# Source = private database (5433), Target = PostgreSQL 17 (5432).
function Invoke-Sql($port, $user, $db, $sql) {
  $f = Join-Path $work 'query.sql'
  [IO.File]::WriteAllText($f, $sql, (New-Object Text.UTF8Encoding $false))
  $out = & $psql -X -q -A -t -v ON_ERROR_STOP=1 -h 127.0.0.1 -p $port -U $user -d $db -f $f
  if ($LASTEXITCODE) { throw "psql failed on port ${port}: $sql" }
  $out
}
function Source($sql) { $env:PGPASSWORD = 'bmu'; try { Invoke-Sql 5433 bmu bmu_hub $sql } finally { Remove-Item Env:PGPASSWORD } }
function Target($sql, $db = 'bmu_hub') { Invoke-Sql 5432 postgres $db $sql }

# --- Checks -------------------------------------------------------------------------------------
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Fail 'Run this from an Administrator PowerShell (it has to restart the PostgreSQL 17 service).' }
if (-not (Test-Path $psql)) { Fail "PostgreSQL 17 not found at $pg17." }
if (-not $embeddedBin -or -not (Test-Path (Join-Path $embeddedBin 'pg_ctl.exe'))) { Fail 'Private database programs not found. Run pnpm install first.' }
if (-not (Test-Path (Join-Path $embeddedData 'PG_VERSION'))) { Fail "No private database at $embeddedData, nothing to migrate." }
# A postmaster.pid left behind by an unclean stop is fine (PostgreSQL clears it on start); only a live process blocks.
$pidFile = Join-Path $embeddedData 'postmaster.pid'
$livePid = if (Test-Path $pidFile) { Get-Process -Id ([int](Get-Content $pidFile -TotalCount 1)) -ErrorAction SilentlyContinue | Where-Object ProcessName -eq 'postgres' }
# Left running on 5433 by an interrupted run of this script (pnpm dev uses 5432): stop it and carry on.
if ($livePid -and (Get-Content $pidFile)[3] -eq '5433') {
  & (Join-Path $embeddedBin 'pg_ctl.exe') stop -D $embeddedData -m fast | Out-Null
  Start-Sleep -Seconds 2
  $livePid = $null
}
if ($livePid) { Fail 'The private database is still running. Stop pnpm dev (Ctrl+C), wait for "Stopping the database...", then run this again.' }
if ((Get-Service $service).Status -ne 'Running') { Start-Service $service }
New-Item -ItemType Directory -Force $work | Out-Null
$env:PGCLIENTENCODING = 'UTF8'

$embeddedStarted = $false
$hbaChanged = $false
$failed = $false
try {
  # --- 1. Private database on 5433 ----------------------------------------------------------------
  Say 'Starting the private database on port 5433...'
  # No -w: pg_ctl's own wait can hang on Windows after an unclean stop, so poll pg_isready instead.
  $starter = Start-Process -FilePath (Join-Path $embeddedBin 'pg_ctl.exe') -ArgumentList @('start', '-D', "`"$embeddedData`"", '-o', '"-p 5433"', '-l', "`"$work\embedded.log`"") -NoNewWindow -PassThru
  # Not Start-Process -Wait: that also waits for the database server pg_ctl launches, which never exits.
  [void]$starter.WaitForExit(30000)
  $embeddedStarted = $true
  $ready = $false
  for ($i = 0; $i -lt 60 -and -not $ready; $i++) {
    & (Join-Path $pg17Bin 'pg_isready.exe') -q -h 127.0.0.1 -p 5433
    if ($LASTEXITCODE -eq 0) { $ready = $true } else { Start-Sleep -Seconds 1 }
  }
  if (-not $ready) { throw "Could not start the private database. See $work\embedded.log" }
  Source 'select 1' | Out-Null

  # --- 2. Temporary local access to PostgreSQL 17 -------------------------------------------------
  Say 'Allowing local access to PostgreSQL 17 for the migration...'
  Copy-Item $hba $hbaBackup -Force
  $hbaChanged = $true
  $temp = @(
    'host all all 127.0.0.1/32 trust  # TEMPORARY: bmu migration, removed when it finishes',
    'host all all ::1/128 trust       # TEMPORARY: bmu migration, removed when it finishes'
  )
  Set-Content -Path $hba -Value ($temp + (Get-Content $hbaBackup)) -Encoding ascii
  Restart-Service $service
  Start-Sleep -Seconds 3

  # --- 3. User and database -----------------------------------------------------------------------
  Say 'Creating user bmu and database bmu_hub on PostgreSQL 17...'
  Target -db postgres "DO `$`$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'bmu') THEN CREATE ROLE bmu LOGIN PASSWORD 'bmu' CREATEDB; ELSE ALTER ROLE bmu LOGIN PASSWORD 'bmu' CREATEDB; END IF; END `$`$;" | Out-Null
  if ((Target -db postgres "select count(*) from pg_database where datname = 'bmu_hub'") -eq '1') {
    $existing = Target "select count(*) from pg_tables where schemaname = 'public'"
    if ([int]$existing -gt 0) { throw 'PostgreSQL 17 already has a bmu_hub database with tables in it. Nothing was changed; rename or drop it first if you want to replace it.' }
  } else {
    Target -db postgres "CREATE DATABASE bmu_hub OWNER bmu ENCODING 'UTF8' TEMPLATE template0" | Out-Null
  }

  # --- 4. Tables, then rows -----------------------------------------------------------------------
  Say 'Creating the tables (Prisma migrations)...'
  $env:DATABASE_URL = 'postgresql://bmu:bmu@localhost:5432/bmu_hub?schema=public'
  Push-Location $root
  try { pnpm --filter @bmu/api exec prisma migrate deploy; if ($LASTEXITCODE) { throw 'prisma migrate deploy failed' } } finally { Pop-Location }

  $tables = @(Source "select tablename from pg_tables where schemaname = 'public' and tablename <> '_prisma_migrations' order by 1")
  Say "Copying $($tables.Count) tables..."
  foreach ($t in $tables) {
    $file = (Join-Path $work 'table.copy') -replace '\', '/'
    $cols = Source "select string_agg(quote_ident(column_name), ',' order by ordinal_position) from information_schema.columns where table_schema = 'public' and table_name = '$t'"
    Source "\copy public.`"$t`" ($cols) to '$file'" | Out-Null
    # replica mode skips foreign-key checks while loading, so tables can be copied in any order.
    Target "SET session_replication_role = replica;`n\copy public.`"$t`" ($cols) from '$file'" | Out-Null
  }

  # --- 5. Check -----------------------------------------------------------------------------------
  Say 'Comparing row counts...'
  $bad = @()
  foreach ($t in $tables) {
    $a = Source "select count(*) from public.`"$t`""
    $b = Target "select count(*) from public.`"$t`""
    if ($a -ne $b) { $bad += "$t (source $a, PostgreSQL 17 $b)" }
  }
  Target 'ANALYZE' | Out-Null
  if ($bad.Count) { throw "Row counts differ: $($bad -join '; ')" }
  Say "All $($tables.Count) tables copied and row counts match."
}
catch {
  Write-Host "[bmu] $($_.Exception.Message)" -ForegroundColor Red
  $failed = $true
}
finally {
  if ($hbaChanged) {
    Say 'Putting PostgreSQL 17 access rules back...'
    Copy-Item $hbaBackup $hba -Force
    Remove-Item $hbaBackup -Force
    Restart-Service $service
  }
  if ($embeddedStarted) {
    Say 'Stopping the private database...'
    & (Join-Path $embeddedBin 'pg_ctl.exe') stop -D $embeddedData -m fast -w | Out-Null
  }
  Remove-Item Env:PGPASSWORD, Env:DATABASE_URL -ErrorAction SilentlyContinue
  if (-not $failed) { Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($failed) { exit 1 }
Say 'Done. Run pnpm dev: it will find PostgreSQL 17 on port 5432 and use it (sign in with user bmu / password bmu).'
Say 'The old private database is still in .bmu-data; delete that folder once you are happy with the move.'
