#!/usr/bin/env pwsh
# =============================================================================
# SISPAT-AGU — scripts/verify.ps1
# =============================================================================
# Verifica a saúde do ambiente local no Windows/PowerShell:
#   1. Lista status/healthcheck dos containers (docker compose ps).
#   2. (Placeholder) Executa migrações Alembic — ativar quando o backend
#      estiver pronto.
#   3. (Placeholder) Executa a suíte de testes pytest — ativar quando o
#      backend estiver pronto.
#
# Uso:
#   .\scripts\verify.ps1
# =============================================================================

$ErrorActionPreference = "Stop"

$RootDir = Split-Path -Parent $PSScriptRoot
Set-Location $RootDir

$ComposeArgs = @("-f", "docker-compose.yml", "-f", "docker-compose.dev.yml")

Write-Host "==> SISPAT-AGU — verificando status dos containers"
docker compose @ComposeArgs ps

Write-Host ""
Write-Host "==> Resumo de healthcheck por serviço:"
$services = @("backend", "worker", "redis", "frontend")
foreach ($svc in $services) {
    $cid = (docker compose @ComposeArgs ps -q $svc 2>$null)
    if ($cid) {
        $status = docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}sem healthcheck{{end}}' $cid 2>$null
        if (-not $status) { $status = "indisponível" }
        Write-Host "    - $svc`: $status"
    } else {
        Write-Host "    - $svc`: container não encontrado (não iniciado?)"
    }
}

Write-Host ""
Write-Host "==> [PLACEHOLDER] Migrações Alembic"
Write-Host "    Quando o backend (backend/app, backend/migrations) estiver pronto,"
Write-Host "    substitua a linha abaixo pelo comando real, por exemplo:"
Write-Host "      docker compose -f docker-compose.yml -f docker-compose.dev.yml exec backend alembic upgrade head"
# docker compose @ComposeArgs exec backend alembic upgrade head

Write-Host ""
Write-Host "==> [PLACEHOLDER] Testes automatizados (pytest)"
Write-Host "    Quando o backend estiver pronto, substitua a linha abaixo pelo"
Write-Host "    comando real, por exemplo:"
Write-Host "      docker compose -f docker-compose.yml -f docker-compose.dev.yml exec backend pytest"
# docker compose @ComposeArgs exec backend pytest

Write-Host ""
Write-Host "==> Verificação concluída."
