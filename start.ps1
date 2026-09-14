# Siftly Windows launcher — mirrors start.sh
$ErrorActionPreference = "Stop"

Write-Host ""
Write-Host "  Siftly" -ForegroundColor Blue
Write-Host "  AI-powered bookmark manager"
Write-Host ""

# Prefer the official Node.js install over any accidental npm "node" package
$officialNode = "C:\Program Files\nodejs"
if (Test-Path "$officialNode\node.exe") {
  $env:PATH = "$officialNode;$env:PATH"
}

$nodeVersion = (node -v) -replace '^v', ''
$major = [int]($nodeVersion.Split('.')[0])
if ($major -ge 26) {
  Write-Host "  Node $nodeVersion is too new for better-sqlite3." -ForegroundColor Yellow
  Write-Host "  Use Node 22 LTS from https://nodejs.org and retry." -ForegroundColor Yellow
  exit 1
}

if (-not (Test-Path ".env")) {
  Write-Host "  Creating .env with default DATABASE_URL..."
  'DATABASE_URL="file:./prisma/dev.db"' | Set-Content -Encoding ascii .env
  Write-Host ""
}

if (-not (Test-Path "node_modules")) {
  Write-Host "  Installing dependencies..."
  npm install
  # Newer npm may gate native install scripts — approve the ones Siftly needs
  npm install-scripts approve @prisma/engines better-sqlite3 esbuild prisma sharp unrs-resolver 2>$null
  Write-Host ""
}

$generatedClient = "app\generated\prisma\client\index.js"
$schemaFile = "prisma\schema.prisma"
if (-not (Test-Path $generatedClient) -or ((Get-Item $schemaFile).LastWriteTime -gt (Get-Item $generatedClient -ErrorAction SilentlyContinue).LastWriteTime)) {
  Write-Host "  Generating Prisma client..."
  npx prisma generate
}

if (-not (Test-Path "prisma\dev.db")) {
  Write-Host "  Setting up database..."
  npx prisma migrate deploy
  if ($LASTEXITCODE -ne 0) { npx prisma db push }
} else {
  npx prisma migrate deploy 2>$null
}

Write-Host ""
if (Get-Command claude -ErrorAction SilentlyContinue) {
  Write-Host "  ✓ Claude CLI detected" -ForegroundColor Green
  Write-Host "    On Windows, paste an API key in Settings if AI calls fail." -ForegroundColor Yellow
} else {
  Write-Host "  i Add your Anthropic/OpenAI/MiniMax API key in Settings after opening the app." -ForegroundColor Yellow
}
Write-Host ""

$port = if ($env:PORT) { $env:PORT } else { "3000" }
Write-Host "  Starting on http://localhost:$port"
Write-Host "  Press Ctrl+C to stop"
Write-Host ""

Start-Process "http://localhost:$port"
npx next dev -p $port
