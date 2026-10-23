"""Comandos de manutenção (`flask <comando>`), registrados no factory.

Uso na VPS (container do backend):
    docker compose exec backend flask purge-import-previews --dry-run
    docker compose exec backend flask purge-import-previews --older-than-days 7
    docker compose exec backend flask classify-assets            # dry-run (padrão)
    docker compose exec backend flask classify-assets --apply    # grava (autorização!)
    docker compose exec backend flask classify-assets --list-unclassified  # só leitura

Nenhum comando imprime dados de bens/pessoas, segredos ou a URL do banco.
"""
from __future__ import annotations

import logging

import click
from flask import Flask

from app.database.session import get_db_session
from app.services.asset_classification_backfill import (
    LIST_LIMIT_MAX,
    classify_existing_assets,
    list_unclassified_assets,
)
from app.services.import_preview_purge import (
    DEFAULT_OLDER_THAN_DAYS,
    MAX_OLDER_THAN_DAYS,
    MIN_OLDER_THAN_DAYS,
    purge_import_previews,
)

logger = logging.getLogger(__name__)


@click.command("purge-import-previews")
@click.option(
    "--older-than-days",
    type=click.IntRange(MIN_OLDER_THAN_DAYS, MAX_OLDER_THAN_DAYS),
    default=DEFAULT_OLDER_THAN_DAYS,
    show_default=True,
    help="Idade mínima (dias) da prévia final/expirada para ser apagada.",
)
@click.option("--dry-run", is_flag=True, default=False, help="Só conta; não apaga nada.")
def purge_import_previews_command(older_than_days: int, dry_run: bool) -> None:
    """Apaga prévias de importação finais/expiradas (nunca raw_import_records)."""
    try:
        with get_db_session() as db:
            result = purge_import_previews(db, older_than_days=older_than_days, dry_run=dry_run)
    except Exception as exc:  # transação já desfeita por get_db_session
        logger.error("purge-import-previews falhou: %s", type(exc).__name__)
        raise click.ClickException(f"Falha ao expurgar prévias ({type(exc).__name__}).") from None
    verb = "seriam apagadas" if result.dry_run else "apagadas"
    click.echo(
        f"Prévias {verb}: {result.previews} (itens: {result.items}); "
        f"corte: {result.cutoff.isoformat()} ({result.older_than_days} dias)."
    )


@click.command("classify-assets")
@click.option(
    "--apply",
    "apply_changes",
    is_flag=True,
    default=False,
    help="Grava a classificação. Sem esta opção é dry-run (só conta; nada é gravado).",
)
@click.option(
    "--list-unclassified",
    "list_unclassified",
    is_flag=True,
    default=False,
    help="SOMENTE LEITURA: lista id e descrição (truncada) dos bens sem categoria "
    "que nenhuma regra classifica. Incompatível com --apply.",
)
def classify_assets_command(apply_changes: bool, list_unclassified: bool) -> None:
    """Classifica bens ativos SEM categoria pela regra da descrição (dry-run por padrão).

    Nunca sobrescreve classificação existente; descrição sem regra continua
    "não classificada". Requer a migração 0015 aplicada (só com autorização).
    """
    if list_unclassified and apply_changes:
        raise click.UsageError("--list-unclassified é somente leitura e não combina com --apply.")
    if list_unclassified:
        try:
            with get_db_session() as db:
                items = list_unclassified_assets(db)
        except Exception as exc:
            logger.error("classify-assets falhou: %s", type(exc).__name__)
            raise click.ClickException(f"Falha ao listar bens ({type(exc).__name__}).") from None
        for asset_id, description in items:
            click.echo(f"{asset_id}	{description}")
        suffix = f" (limite de {LIST_LIMIT_MAX})" if len(items) >= LIST_LIMIT_MAX else ""
        click.echo(f"Sem regra: {len(items)}{suffix}. Somente leitura: nada foi gravado.")
        return
    try:
        with get_db_session() as db:
            report = classify_existing_assets(db, apply=apply_changes)
    except Exception as exc:  # transação já desfeita por get_db_session
        logger.error("classify-assets falhou: %s", type(exc).__name__)
        raise click.ClickException(f"Falha ao classificar bens ({type(exc).__name__}).") from None
    verb = "seriam classificados" if report.dry_run else "classificados"
    click.echo(
        f"Bens sem categoria: {report.candidates}; {verb}: {report.classified}; "
        f"sem regra (continuam não classificados): {report.unmatched}."
    )
    for name, count in sorted(report.by_category.items()):
        click.echo(f"  {name}: {count}")
    for name, count in sorted(report.by_tech_type.items()):
        click.echo(f"  TI/{name}: {count}")
    if report.dry_run:
        click.echo("Dry-run: nada foi gravado. Use --apply para gravar.")


def register_cli(app: Flask) -> None:
    app.cli.add_command(purge_import_previews_command)
    app.cli.add_command(classify_assets_command)
