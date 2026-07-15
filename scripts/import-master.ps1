param(
  [Parameter(Mandatory = $true)][string]$WorkbookPath,
  [string]$OutputDirectory = "master/data"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Read-EntryText($zip, [string]$name) {
  $entry = $zip.GetEntry($name)
  if ($null -eq $entry) { return $null }
  $reader = New-Object IO.StreamReader($entry.Open())
  try { return $reader.ReadToEnd() } finally { $reader.Dispose() }
}

function Column-Index([string]$reference) {
  $letters = ([regex]::Match($reference, '^[A-Z]+')).Value
  $index = 0
  foreach ($character in $letters.ToCharArray()) {
    $index = ($index * 26) + ([int]$character - [int][char]'A' + 1)
  }
  return $index - 1
}

function Convert-Value($cell, $sharedStrings, $namespace) {
  $type = [string]$cell.t
  if ($type -eq 'inlineStr') {
    return (($cell.SelectNodes('.//m:is//m:t', $namespace) | ForEach-Object { $_.'#text' }) -join '')
  }
  $valueNode = $cell.SelectSingleNode('./m:v', $namespace)
  if ($null -eq $valueNode) { return $null }
  $raw = [string]$valueNode.InnerText
  if ($type -eq 's') { return $sharedStrings[[int]$raw] }
  if ($type -eq 'b') { return $raw -eq '1' }
  $number = 0.0
  if ([double]::TryParse($raw, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$number)) {
    if ($number -eq [math]::Truncate($number)) { return [long]$number }
    return $number
  }
  return $raw
}

function Convert-Sheet($zip, [string]$entryName, $sharedStrings) {
  [xml]$sheet = Read-EntryText $zip $entryName
  $namespace = New-Object Xml.XmlNamespaceManager($sheet.NameTable)
  $namespace.AddNamespace('m', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
  $rows = @()
  foreach ($row in $sheet.SelectNodes('//m:sheetData/m:row', $namespace)) {
    $values = @{}
    foreach ($cell in $row.SelectNodes('./m:c', $namespace)) {
      $values[(Column-Index ([string]$cell.r))] = Convert-Value $cell $sharedStrings $namespace
    }
    if ($values.Count -gt 0) {
      $last = ($values.Keys | Measure-Object -Maximum).Maximum
      $array = for ($index = 0; $index -le $last; $index++) { if ($values.ContainsKey($index)) { $values[$index] } else { $null } }
      $rows += ,$array
    }
  }
  return $rows
}

function Convert-Rows($rows, $mapping) {
  if ($rows.Count -lt 2) { return @() }
  $headers = @($rows[0])
  $indexes = @{}
  for ($index = 0; $index -lt $headers.Count; $index++) { $indexes[[string]$headers[$index]] = $index }
  $result = @()
  foreach ($row in $rows[1..($rows.Count - 1)]) {
    if ($null -eq $row[0] -or [string]::IsNullOrWhiteSpace([string]$row[0])) { continue }
    $item = [ordered]@{}
    foreach ($header in $mapping.Keys) {
      if (-not $indexes.ContainsKey($header)) { throw "Missing header: $header" }
      $position = $indexes[$header]
      $item[$mapping[$header]] = if ($position -lt $row.Count) { $row[$position] } else { $null }
    }
    $result += [pscustomobject]$item
  }
  return $result
}

$maps = [ordered]@{
  'カード一覧' = @{ file='cards.json'; columns=[ordered]@{'カードID'='id';'正式名称'='name';'カテゴリ'='category';'術体系'='system';'属性'='attribute';'テンプレートID'='templateId';'コスト'='cost';'MP消費量'='mpCost';'weight'='weight';'対象'='target';'使用タイミング'='timing';'効果'='effectText';'説明文'='description';'フレーバーテキスト'='flavorText'} }
  'テンプレート一覧' = @{ file='cardTemplates.json'; columns=[ordered]@{'テンプレートID'='id';'テンプレート名'='name';'カテゴリ'='category';'術体系'='system';'基本画像'='imageId';'基本説明'='description';'属性展開有無'='hasAttributeVariants'} }
  '式神一覧' = @{ file='shikigami.json'; columns=[ordered]@{'式神ID'='id';'名称'='name';'属性'='attribute';'最大HP'='maxHp';'攻撃力'='attack';'固有AI'='aiProfile';'キーワード能力'='keywords';'固有能力'='ability';'説明'='description';'画像ID'='imageId'} }
  '結界一覧' = @{ file='barriers.json'; columns=[ordered]@{'結界ID'='id';'名称'='name';'属性'='attribute';'術体系'='system';'発動タイミング'='timing';'対象'='target';'効果'='effectText';'耐久値'='durability';'発動回数'='triggerCount';'説明'='description'} }
  '地形一覧' = @{ file='terrains.json'; columns=[ordered]@{'地形ID'='id';'名称'='name';'属性'='attribute';'術体系'='system';'発動タイミング'='timing';'対象'='target';'効果'='effectText';'説明'='description'} }
  '禁術一覧' = @{ file='forbiddenArts.json'; columns=[ordered]@{'禁術ID'='id';'名称'='name';'属性'='attribute';'カテゴリ'='category';'術体系'='system';'コスト'='cost';'MP消費量'='mpCost';'weight'='weight';'対象'='target';'効果'='effectText';'説明'='description'} }
  'キーワード能力一覧' = @{ file='keywords.json'; columns=[ordered]@{'能力ID'='id';'名称'='name';'分類'='classification';'効果'='effectText';'説明'='description'} }
  '呪い一覧' = @{ file='curses.json'; columns=[ordered]@{'呪いID'='id';'名称'='name';'効果'='effectText';'解除条件'='removalCondition';'重複可否'='stacking';'説明'='description'} }
  'AI評価値一覧' = @{ file='aiScores.json'; columns=[ordered]@{'評価ID'='id';'対象'='target';'評価値'='score';'備考'='notes'} }
}

$zip = [IO.Compression.ZipFile]::OpenRead((Resolve-Path $WorkbookPath))
try {
  [xml]$workbook = Read-EntryText $zip 'xl/workbook.xml'
  $workbookNs = New-Object Xml.XmlNamespaceManager($workbook.NameTable)
  $workbookNs.AddNamespace('m', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
  $workbookNs.AddNamespace('r', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
  [xml]$relationships = Read-EntryText $zip 'xl/_rels/workbook.xml.rels'
  $relationshipMap = @{}
  foreach ($relationship in $relationships.Relationships.Relationship) { $relationshipMap[[string]$relationship.Id] = [string]$relationship.Target }
  $sharedStrings = @()
  $sharedXml = Read-EntryText $zip 'xl/sharedStrings.xml'
  if ($sharedXml) {
    [xml]$shared = $sharedXml
    $sharedNs = New-Object Xml.XmlNamespaceManager($shared.NameTable)
    $sharedNs.AddNamespace('m', 'http://schemas.openxmlformats.org/spreadsheetml/2006/main')
    $sharedStrings = @($shared.SelectNodes('//m:si', $sharedNs) | ForEach-Object { (($_.SelectNodes('.//m:t', $sharedNs) | ForEach-Object { $_.'#text' }) -join '') })
  }
  New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
  foreach ($sheetNode in $workbook.SelectNodes('//m:sheets/m:sheet', $workbookNs)) {
    $title = [string]$sheetNode.name
    if (-not $maps.Contains($title)) { continue }
    $relationId = $sheetNode.GetAttribute('id', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
    $entryName = 'xl/' + $relationshipMap[$relationId].TrimStart('/')
    $data = Convert-Rows (Convert-Sheet $zip $entryName $sharedStrings) $maps[$title].columns
    $json = ConvertTo-Json -InputObject @($data) -Depth 8
    [IO.File]::WriteAllText((Join-Path $OutputDirectory $maps[$title].file), $json + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
    Write-Host "$title -> $($maps[$title].file): $($data.Count) rows"
  }
}
finally { $zip.Dispose() }
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($null -ne $nodeCommand) {
  $nodeExecutable = $nodeCommand.Source
} elseif (Test-Path 'C:\Program Files\nodejs\node.exe') {
  $nodeExecutable = 'C:\Program Files\nodejs\node.exe'
} else {
  throw 'Node.js が見つかりません。マスターJSONの生成を続行できません。'
}

& $nodeExecutable 'scripts/build-data.mjs'
if ($LASTEXITCODE -ne 0) { throw 'マスターJSONの生成に失敗しました。' }
Write-Host 'server/data の生成と検証が完了しました。'
