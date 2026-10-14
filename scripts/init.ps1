#!/usr/bin/env pwsh
# =============================================================================
# SISPAT-AGU — scripts/init.ps1
# =============================================================================
# Inicializa o ambiente de desenvolvimento local no Windows/PowerShell:
#   1. Copia .env.example para .env (se ainda não existir).
#   2. Sobe os containers de desenvolvimento (base + overrides de dev).
#
# Uso:
#   .\scripts\init.ps1
# =============================================================================

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $PSScriptRoot
Set-Location $RootDir

Write-Host "==> SISPAT-AGU — inicializando ambiente de desenvolvimento"

$envPath = Join-Path $RootDir ".env"
$envExamplePath = Join-Path $RootDir ".env.example"

if (-not (Test-Path $envPath)) {
    if (Test-Path $envExamplePath) {
        Copy-Item -Path $envExamplePath -Destination $envPath
        Write-Host "==> Arquivo .env criado a partir de .env.example."
        Write-Host "    IMPORTANTE: edite o .env e preencha as credenciais reais"
        Write-Host "    antes de usar o ambiente (nunca versionar o .env)."
    } else {
        Write-Error "ERRO: .env.example não encontrado em $RootDir."
        exit 1
    }
} else {
    Write-Host "==> Arquivo .env já existe — mantendo o atual."
}

$dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
if (-not $dockerCmd) {
    Write-Error "ERRO: Docker não encontrado no PATH. Instale o Docker Desktop."
    exit 1
}

Write-Host "==> Subindo containers (docker-compose.yml + docker-compose.dev.yml)..."
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build

if ($LASTEXITCODE -ne 0) {
    Write-Error "ERRO: falha ao subir os containers (docker compose retornou $LASTEXITCODE)."
    exit $LASTEXITCODE
}

Write-Host "==> Ambiente de desenvolvimento iniciado."
Write-Host "    Use 'docker compose -f docker-compose.yml -f docker-compose.dev.yml ps'"
Write-Host "    para verificar o status, ou execute scripts\verify.ps1."
