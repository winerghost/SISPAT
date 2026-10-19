"""Alertas determinísticos do dashboard (Etapa 4a). Sem IA: só SQL/regras."""
from app.services.alerts.rules import RULES, AlertItem, AlertRule, RuleContext
from app.services.alerts.service import evaluate_alerts

__all__ = ["RULES", "AlertItem", "AlertRule", "RuleContext", "evaluate_alerts"]
