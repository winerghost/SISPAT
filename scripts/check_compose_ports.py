"""Valida a saída JSON de `docker compose config --format json` (stdin).

Regras (CLAUDE.md / docs/security/evidence/devsecops.md):
- toda porta publicada deve estar vinculada a 127.0.0.1;
- nenhuma porta publicada 80/443 (ocupadas pelo CloudPanel);
- nenhum serviço n8n;
- serviços de produção (backend/frontend/worker/redis) com
  no-new-privileges e cap_drop ALL.
Saída: 0 se OK, 1 se houver violação.
"""
from __future__ import annotations

import json
import sys

HARDENED = {"backend", "frontend", "worker", "redis"}


def main() -> int:
    cfg = json.load(sys.stdin)
    errors: list[str] = []
    for name, svc in (cfg.get("services") or {}).items():
        if "n8n" in name.lower() or "n8n" in str(svc.get("image", "")).lower():
            errors.append(f"{name}: serviço n8n não é permitido (n8n é externo)")
        for port in svc.get("ports") or []:
            host_ip = port.get("host_ip") or "0.0.0.0"
            published = str(port.get("published") or "")
            if host_ip != "127.0.0.1":
                errors.append(f"{name}: porta {published} publicada em {host_ip} (exigido 127.0.0.1)")
            if published in {"80", "443"}:
                errors.append(f"{name}: porta {published} é reservada ao CloudPanel")
        if name in HARDENED:
            if "no-new-privileges:true" not in (svc.get("security_opt") or []):
                errors.append(f"{name}: falta security_opt no-new-privileges:true")
            if "ALL" not in (svc.get("cap_drop") or []):
                errors.append(f"{name}: falta cap_drop: [ALL]")
    for err in errors:
        print(f"    [FALHA] {err}")
    if not errors:
        print("    compose: portas só em 127.0.0.1, sem 80/443, sem n8n, hardening presente")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
