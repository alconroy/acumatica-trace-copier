<#
.SYNOPSIS
    Builds distributable Chrome and Firefox packages for Acumatica Trace Copier.

.DESCRIPTION
    All extension source is shared between the two browsers -- every .js, .css
    and .html file is byte-identical in both builds. The only difference is the
    manifest:

      * Firefox requires a browser_specific_settings.gecko block. It is needed
        to publish on addons.mozilla.org, and separately it is what makes
        storage.sync work at all -- Firefox keys sync storage on the add-on ID,
        so without it the options page silently fails to persist.
      * Chrome does not understand that key and reports it as an unrecognized
        manifest key on chrome://extensions.

    So manifest.json in the repo root is the single source of truth and is
    Chrome-shaped: it can still be loaded directly via "Load unpacked" with no
    warnings. This script copies it verbatim for the Chrome build and injects
    the gecko block for the Firefox build. Version, permissions and everything
    else come from the one file, so the two builds cannot drift.

.PARAMETER Browser
    Which package(s) to build: chrome, firefox, or all (default).

.PARAMETER NoZip
    Stage the unpacked folders but skip creating the .zip files. Useful while
    iterating -- point "Load unpacked" / about:debugging at the staged folder.

.EXAMPLE
    .\tools\build.ps1
    Builds dist\chrome\ and dist\firefox\ plus a zip for each.

.EXAMPLE
    .\tools\build.ps1 -Browser firefox -NoZip
    Stages dist\firefox\ only, for loading in about:debugging.
#>

[CmdletBinding()]
param(
    [ValidateSet('chrome', 'firefox', 'all')]
    [string]$Browser = 'all',

    [switch]$NoZip
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------- settings --

# Firefox add-on identity. The id must stay stable for the life of the add-on:
# changing it makes AMO treat the result as a different extension and orphans
# every user's synced storage.
#
# The version floors are set by data_collection_permissions below, which landed
# in Firefox 140 on desktop and 142 on Android. Declaring a lower floor makes
# AMO warn that the extension claims support for releases that would silently
# ignore the data consent declaration. An earlier floor of 127.0 was used here
# (the release where content_scripts host permissions began being granted at
# install time rather than being purely opt-in); 140 supersedes it and keeps
# that behaviour, since 140 > 127.
$GeckoId                = 'acumatica-trace-copier@alconroy'
$GeckoMinVersion        = '140.0'
$GeckoAndroidMinVersion = '142.0'

# AMO requires every new extension to declare what personal data it collects or
# transmits (mandatory for new submissions from 2025-11-03). This extension
# collects and transmits nothing: there is no fetch, no XHR and no network call
# anywhere in the codebase, copied text goes only to the user's own clipboard,
# and the saved AI prompt is browser-native storage.sync of the user's own
# setting -- none of it leaves the device. "none" is the value Mozilla defines
# for that case and it is mutually exclusive with every other value.
#
# This is a disclosure you are attesting to. Revisit it the moment the extension
# gains any network call, telemetry, or off-device storage.
$GeckoDataCollection = 'none'

# Everything that ships. Listed explicitly rather than globbing the repo so the
# working files (inspection.txt, MARKETING_BRIEF.md, store-assets\, ...) can
# never leak into a published package.
$PayloadFiles = @(
    'content.css',
    'content.js',
    'options.html',
    'options.js',
    'popup.html',
    'popup.js',
    'prompts.js'
)
$PayloadDirs = @(
    'icons'
)

$RepoRoot       = Split-Path -Parent $PSScriptRoot
$DistRoot       = Join-Path $RepoRoot 'dist'
$SourceManifest = Join-Path $RepoRoot 'manifest.json'

# --------------------------------------------------------------- functions --

function Write-TextNoBom {
    <#
        Set-Content -Encoding utf8 emits a BOM on Windows PowerShell 5.1.
        web-ext lint and some manifest parsers object to it, so write the
        bytes ourselves.
    #>
    param(
        [Parameter(Mandatory)][string]$Path,
        [Parameter(Mandatory)][string]$Text
    )
    $utf8NoBom = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Text, $utf8NoBom)
}

function New-FirefoxManifest {
    <#
        Injects the gecko block as text immediately after the opening brace
        rather than round-tripping through ConvertTo-Json. PowerShell 5.1's
        serializer defaults to -Depth 2, which would silently mangle the nested
        content_scripts array, and it escapes angle brackets, which would turn
        "<all_urls>" into a valid but unreadable \u-escaped string. Text
        insertion preserves the source formatting exactly, so a diff between
        the two generated manifests shows only the added block.
    #>
    param([Parameter(Mandatory)][string]$SourceText)

    $block = @"
  "browser_specific_settings": {
    "gecko": {
      "id": "$GeckoId",
      "strict_min_version": "$GeckoMinVersion",
      "data_collection_permissions": {
        "required": ["$GeckoDataCollection"]
      }
    },
    "gecko_android": {
      "strict_min_version": "$GeckoAndroidMinVersion"
    }
  },
"@

    $brace = $SourceText.IndexOf('{')
    if ($brace -lt 0) {
        throw 'manifest.json does not contain an opening brace.'
    }

    return $SourceText.Substring(0, $brace + 1) + "`n" + $block + $SourceText.Substring($brace + 1)
}

function Assert-ZipEntryNames {
    <#
        Guards the separator bug described in Build-Package. ZipArchiveEntry
        returns FullName exactly as stored, so a backslash here means the
        archive would be rejected on upload. Fail the build rather than hand
        over a package that only fails later at the store.

        Do NOT verify this with Python's zipfile module: on Windows,
        ZipInfo.__init__ rewrites os.sep to "/", so namelist() reports clean
        names for an archive that is actually malformed. Check the raw bytes,
        or use this assertion.
    #>
    param([Parameter(Mandatory)][string]$ZipPath)

    $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
    try {
        $bad = @($archive.Entries | Where-Object { $_.FullName.Contains('\') })
        if ($bad.Count -gt 0) {
            throw ("Archive has backslash entry names, which stores reject: {0}" -f (($bad | ForEach-Object { $_.FullName }) -join ', '))
        }

        $names = @($archive.Entries | ForEach-Object { $_.FullName })
        if ($names -notcontains 'manifest.json') {
            throw "manifest.json is not at the root of $ZipPath"
        }
    }
    finally {
        $archive.Dispose()
    }
}

function Build-Package {
    param(
        [Parameter(Mandatory)][string]$Target,
        [Parameter(Mandatory)][string]$ManifestText,
        [Parameter(Mandatory)][string]$Version
    )

    $stageDir = Join-Path $DistRoot $Target

    if (Test-Path $stageDir) {
        Remove-Item $stageDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $stageDir -Force | Out-Null

    foreach ($file in $PayloadFiles) {
        $src = Join-Path $RepoRoot $file
        if (-not (Test-Path $src)) {
            throw "Missing payload file: $file"
        }
        Copy-Item -Path $src -Destination (Join-Path $stageDir $file)
    }

    foreach ($dir in $PayloadDirs) {
        $src = Join-Path $RepoRoot $dir
        if (-not (Test-Path $src)) {
            throw "Missing payload folder: $dir"
        }
        Copy-Item -Path $src -Destination $stageDir -Recurse
    }

    Write-TextNoBom -Path (Join-Path $stageDir 'manifest.json') -Text $ManifestText

    $fileCount = (Get-ChildItem $stageDir -Recurse -File).Count
    Write-Host ("  {0,-8} staged  {1}  ({2} files)" -f $Target, $stageDir, $fileCount)

    if ($NoZip) {
        return
    }

    # Both stores require manifest.json at the root of the archive.
    #
    # Entries are added by hand rather than with ZipFile::CreateFromDirectory,
    # which on .NET Framework (Windows PowerShell 5.1) writes entry names using
    # the platform separator -- producing "icons\icon128.png". The ZIP spec
    # requires forward slashes, and AMO rejects such an archive outright with
    # "Invalid file name in archive: icons\icon128.png". Building the names
    # explicitly is the only way to guarantee the separator on 5.1.
    $zipPath = Join-Path $DistRoot "acumatica-trace-copier-$Target-v$Version.zip"
    if (Test-Path $zipPath) {
        Remove-Item $zipPath -Force
    }

    $stageFull = (Get-Item $stageDir).FullName
    $archive = [System.IO.Compression.ZipFile]::Open(
        $zipPath,
        [System.IO.Compression.ZipArchiveMode]::Create
    )
    try {
        foreach ($item in (Get-ChildItem $stageFull -Recurse -File | Sort-Object FullName)) {
            $entryName = $item.FullName.Substring($stageFull.Length + 1).Replace('\', '/')
            $null = [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $archive,
                $item.FullName,
                $entryName,
                [System.IO.Compression.CompressionLevel]::Optimal
            )
        }
    }
    finally {
        $archive.Dispose()
    }

    Assert-ZipEntryNames -ZipPath $zipPath

    $sizeKb = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
    Write-Host ("  {0,-8} packed  {1}  ({2} KB)" -f $Target, $zipPath, $sizeKb)
}

# ------------------------------------------------------------------- build --

# ZipFile/ZipFileExtensions live in .FileSystem; ZipArchiveMode lives in the
# base System.IO.Compression assembly. Both are needed.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (-not (Test-Path $SourceManifest)) {
    throw "Source manifest not found: $SourceManifest"
}

$chromeManifest = Get-Content $SourceManifest -Raw

# Parsed for validation and to read the version. The parsed object is not used
# to regenerate the file -- see New-FirefoxManifest for why.
$parsed  = $chromeManifest | ConvertFrom-Json
$version = $parsed.version
if ([string]::IsNullOrWhiteSpace($version)) {
    throw 'manifest.json has no version.'
}

if ($parsed.PSObject.Properties.Name -contains 'browser_specific_settings') {
    throw 'manifest.json already contains browser_specific_settings. The source manifest is meant to stay Chrome-shaped; the Firefox block is added by this script.'
}

$firefoxManifest = New-FirefoxManifest -SourceText $chromeManifest
$null = $firefoxManifest | ConvertFrom-Json   # fail loudly if insertion broke the JSON

New-Item -ItemType Directory -Path $DistRoot -Force | Out-Null

Write-Host ""
Write-Host "Acumatica Trace Copier v$version"
Write-Host ""

if ($Browser -eq 'chrome' -or $Browser -eq 'all') {
    Build-Package -Target 'chrome' -ManifestText $chromeManifest -Version $version
}
if ($Browser -eq 'firefox' -or $Browser -eq 'all') {
    Build-Package -Target 'firefox' -ManifestText $firefoxManifest -Version $version
}

Write-Host ""
