// Contrato de paginação do backend (app/services/pagination.py): `page_size`
// aceita SOMENTE 50, 100 ou 200 (padrão 50); qualquer outro valor -> 400.
// Compartilhado pelos mocks para que a UI nunca "passe" no teste enviando um
// tamanho que o backend real recusaria.
export const ALLOWED_PAGE_SIZES = [50, 100, 200] as const;
export const DEFAULT_MOCK_PAGE_SIZE = 50;

/** `page_size` da query; `null` = inválido (mock responde 400). Ausente = 50. */
export function mockPageSize(params: URLSearchParams): number | null {
  const raw = params.get("page_size");
  if (raw === null) return DEFAULT_MOCK_PAGE_SIZE;
  return /^\d{1,3}$/.test(raw) && (ALLOWED_PAGE_SIZES as readonly number[]).includes(Number(raw)) ? Number(raw) : null;
}

/** `page` da query; `null` = inválido (1..100000). Ausente = 1. */
export function mockPage(params: URLSearchParams): number | null {
  const raw = params.get("page");
  if (raw === null) return 1;
  const n = /^\d{1,6}$/.test(raw) ? Number(raw) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= 100_000 ? n : null;
}
