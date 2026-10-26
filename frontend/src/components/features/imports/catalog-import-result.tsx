"use client";

import { CircleCheck, CircleX, TriangleAlert } from "lucide-react";

import { pendingLabel } from "./catalog-import-labels";
import {
  CLASSIFICATION_PT,
  deriveOutcome,
  failureCount,
  OUTCOME_TITLE,
  savedCount,
  UNWRITTEN_REASON_LABEL,
  type CatalogOutcome,
  type ConfirmResultView,
} from "./catalog-import-outcome";

// =============================================================================
// CatalogImportResult — resultado da confirmação. Só exibe o que o backend
// devolveu (contadores, status e falhas por item); aparece APÓS a resposta,
// nunca de forma otimista, e os números não são animados. O tom depende do
// estado derivado: sucesso (verde), parcial (laranja), falha total/nada salvo
// (laranja com ícone de erro) — nunca "sucesso" quando nada foi salvo. Ícone +
// texto (a cor nunca é o único sinal). Serve cadastros e bens (mesmo contrato):
// em bens (`kind` ausente) mostra também as pendências de vínculo dos bens criados
// (sala, pessoa, unidade pertencente) e o aviso de resposta degradada. As falhas trazem linha, nome e motivo
// (texto escapado pelo React); o backend lista no máximo 100 e informa o total.
// =============================================================================

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-eyebrow text-pale-stone">{label}</dt>
      <dd className="text-body text-bone" data-stat={label}>
        {value}
      </dd>
    </div>
  );
}

const TONE: Record<CatalogOutcome, { border: string; text: string }> = {
  success: { border: "border-metric-green/40", text: "text-metric-green" },
  partial: { border: "border-signal-orange/40", text: "text-signal-orange" },
  failure: { border: "border-signal-orange/40", text: "text-signal-orange" },
  nothing: { border: "border-ash-stroke", text: "text-pale-stone" },
};

export function reasonLabel(code: string): string {
  return UNWRITTEN_REASON_LABEL[code] ?? pendingLabel(code);
}

const LINK_PENDING_CODES_ORDER = [
  "sala_nao_encontrada",
  "sala_ambigua",
  "pessoa_nao_encontrada",
  "pessoa_ambigua",
  "usuario_pessoa_nao_encontrada",
  "usuario_pessoa_ambigua",
  "unidade_pertencente_nao_encontrada",
];

export function CatalogImportResult({ result }: { result: ConfirmResultView }) {
  const failures = result.falhas ?? [];
  const failuresTotal = failureCount(result);
  const outcome = deriveOutcome(result);
  const tone = TONE[outcome];
  const unwritten = result.nao_gravados;
  const classes = Object.entries(unwritten?.por_classificacao ?? {}).filter(([, count]) => count > 0);
  const reasons = Object.entries(unwritten?.por_motivo ?? {}).filter(([, count]) => count > 0);
  const aliasMissing = unwritten?.por_motivo?.unidade_sem_alias ?? 0;
  const dependsOnAlias = result.kind !== "units";
  const isAssets = result.kind === undefined;
  const linkPending = Object.entries(result.pendencias_vinculo ?? {})
    .filter(([, count]) => count > 0)
    .sort(([a], [b]) => {
      const ia = LINK_PENDING_CODES_ORDER.indexOf(a);
      const ib = LINK_PENDING_CODES_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  const Icon = outcome === "success" ? CircleCheck : outcome === "failure" ? CircleX : TriangleAlert;

  return (
    <section
      aria-labelledby="catalog-result-title"
      data-testid="catalog-import-result"
      data-outcome={outcome}
      className={`flex flex-col gap-4 rounded-cards border bg-carbon-lift p-card-padding ${tone.border}`}
    >
      <h2 id="catalog-result-title" className="text-eyebrow text-pale-stone">
        Resultado da importação
      </h2>
      <p role="status" className={`inline-flex items-start gap-2 text-body-sm ${tone.text}`}>
        <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>{OUTCOME_TITLE[outcome]}</span>
      </p>

      {result.degraded ? (
        <p
          role="status"
          data-testid="catalog-import-degraded"
          className="flex items-start gap-2 text-body-sm text-signal-orange"
        >
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>
            Os dados foram gravados, mas o servidor não conseguiu montar o detalhamento completo. Os totais abaixo são
            confiáveis; as listas de itens não gravados e rejeitados não estão disponíveis (consulte o histórico da
            sincronização).
          </span>
        </p>
      ) : null}

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Salvos" value={savedCount(result)} />
        <Stat label="Criados" value={result.created} />
        <Stat label="Atualizados" value={result.updated} />
        <Stat label="Inalterados" value={result.inalterados ?? 0} />
        <Stat label="Rejeitados" value={failuresTotal} />
        <Stat label="Ignorados" value={result.ignorados} />
      </dl>
      <p className="text-caption text-warm-granite">
        Salvos = criados + atualizados. Inalterados: itens existentes que já estavam iguais à planilha (nada a
        gravar). Rejeitados: itens enviados que o servidor recusou ao gravar. Ignorados: IDs enviados que não são
        itens elegíveis desta prévia.
      </p>

      {unwritten && (unwritten.total > 0 || unwritten.nao_selecionados > 0) ? (
        <div className="flex flex-col gap-2" data-testid="catalog-import-unwritten">
          <h3 className="text-eyebrow text-pale-stone">
            Linhas da planilha que não são gravadas <span className="text-bone">({unwritten.total})</span>
          </h3>
          <p className="text-body-sm text-warm-granite">
            Linhas inválidas, duplicadas ou conflitantes nunca são gravadas por esta importação: corrija-as na
            planilha e gere uma nova prévia.
          </p>
          {classes.length > 0 ? (
            <ul className="flex flex-col gap-1 text-body-sm" data-testid="catalog-import-unwritten-classes">
              {classes.map(([code, count]) => (
                <li key={code} data-unwritten-class={code}>
                  {CLASSIFICATION_PT[code] ?? code}: <span className="text-bone">{count}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {reasons.length > 0 ? (
            <ul className="flex flex-col gap-1 text-body-sm" data-testid="catalog-import-unwritten-reasons">
              {reasons.map(([code, count]) => (
                <li key={code} data-unwritten-reason={code} className="min-w-0 break-words [overflow-wrap:anywhere]">
                  {reasonLabel(code)}: <span className="text-bone">{count}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {unwritten.nao_selecionados > 0 ? (
            <p className="text-body-sm" data-testid="catalog-import-unselected">
              Itens elegíveis que você não selecionou: <span className="text-bone">{unwritten.nao_selecionados}</span>
            </p>
          ) : null}
        </div>
      ) : null}

      {dependsOnAlias && aliasMissing > 0 ? (
        <p
          role="status"
          data-testid="catalog-import-alias-warning"
          className="flex items-start gap-2 text-body-sm text-signal-orange"
        >
          <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
          <span>
            {aliasMissing} linha(s) não foram gravadas porque a sigla da coluna UNIDADE não tem alias cadastrado.
            Importe primeiro as unidades (marcando a criação das siglas) e gere uma nova prévia.
          </span>
        </p>
      ) : null}

      {isAssets && linkPending.length > 0 ? (
        <div className="flex flex-col gap-2" data-testid="catalog-import-link-pending">
          <h3 className="text-eyebrow text-pale-stone">Bens criados com vínculo pendente</h3>
          <p className="text-body-sm text-warm-granite">
            Estes bens foram gravados sem o vínculo abaixo (não bloqueia): cadastre o item de apoio e vincule-o na edição
            do bem.
          </p>
          <ul className="flex flex-col gap-1 text-body-sm">
            {linkPending.map(([code, count]) => (
              <li key={code} data-link-pending={code} className="flex min-w-0 items-start gap-2 break-words [overflow-wrap:anywhere]">
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal-orange" aria-hidden="true" />
                <span>
                  {pendingLabel(code)}: <span className="text-bone">{count}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {failuresTotal > 0 ? (
        <div className="flex flex-col gap-2">
          <h3 className="text-eyebrow text-pale-stone">Itens rejeitados ao gravar</h3>
          <ul className="flex flex-col gap-1.5 text-body-sm" data-testid="catalog-import-failures">
            {failures.map((failure, index) => (
              <li
                key={`${failure.item_id ?? "item"}-${index}`}
                className="flex min-w-0 items-start gap-2 break-words [overflow-wrap:anywhere]"
              >
                <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal-orange" aria-hidden="true" />
                <span>
                  {typeof failure.row === "number" ? `Linha ${failure.row}` : "Linha desconhecida"}
                  {failure.label ? ` — ${failure.label}` : ""}
                  {failure.reason ? `: ${failure.reason}` : ""}
                </span>
              </li>
            ))}
          </ul>
          {failuresTotal > failures.length ? (
            <p className="text-caption text-warm-granite" data-testid="catalog-import-failures-more">
              Mostrando {failures.length} de {failuresTotal} rejeitado(s); consulte o histórico da sincronização
              (registros REJEITADO) para o restante.
            </p>
          ) : null}
        </div>
      ) : null}
      <p className="text-caption text-warm-granite">
        Para importar outra vez, gere uma nova prévia: a anterior foi consumida e não pode ser confirmada de novo.
      </p>
    </section>
  );
}
