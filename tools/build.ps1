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
# every user's synced storage. 127.0 is the floor because that is the release
# where Firefox began granting content_scripts host permissions at install time
# rather than leaving them entirely opt-in.
$GeckoId         = 'acumatica-trace-copier@alconroy'
$GeckoMinVersion = '127.0'

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
      "strict_min_version": "$GeckoMinVersion"
    }
  },
"@

    $brace = $SourceText.IndexOf('{')
    if ($brace -lt 0) {
        throw 'manifest.json does not contain an opening brace.'
    }

    return $SourceText.Substring(0, $brace + 1) + "`n" + $block + $SourceText.Substring($brace + 1)
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
    # CreateFromDirectory places the folder's *contents* at the zip root.
    $zipPath = Join-Path $DistRoot "acumatica-trace-copier-$Target-v$Version.zip"
    if (Test-Path $zipPath) {
        Remove-Item $zipPath -Force
    }
    [System.IO.Compression.ZipFile]::CreateFromDirectory(
        $stageDir,
        $zipPath,
        [System.IO.Compression.CompressionLevel]::Optimal,
        $false
    )

    $sizeKb = [math]::Round((Get-Item $zipPath).Length / 1KB, 1)
    Write-Host ("  {0,-8} packed  {1}  ({2} KB)" -f $Target, $zipPath, $sizeKb)
}

# ------------------------------------------------------------------- build --

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
