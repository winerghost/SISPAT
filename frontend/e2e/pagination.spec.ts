import { expect, test } from "@playwright/test";

import {
  DEFAULT_PAGE_SIZE,
  PAGE_SIZE_OPTIONS,
  pageRange,
  parsePage,
  parsePageSize,
  readPaginationFromSearch,
  totalPagesFor,
  writePaginationToSearch,
} from "../src/lib/pagination";

// Unitário dos helpers de paginação (backend só aceita 50/100/200).
test.describe("pagination helpers", () => {
  test("opções e padrão", () => {
    expect([...PAGE_SIZE_OPTIONS]).toEqual([50, 100, 200]);
    expect(DEFAULT_PAGE_SIZE).toBe(50);
  });

  test("parsePageSize rejeita valores fora da allowlist", () => {
    expect(parsePageSize("100")).toBe(100);
    expect(parsePageSize(200)).toBe(200);
    for (const bad of ["25", "0", "-1", "abc", null, undefined, 51, "1e2"]) {
      expect(parsePageSize(bad)).toBe(50);
    }
  });

  test("parsePage", () => {
    expect(parsePage("3")).toBe(3);
    for (const bad of ["0", "-2", "1.5", "x", null, undefined]) expect(parsePage(bad)).toBe(1);
  });

  test("totalPagesFor e pageRange", () => {
    expect(totalPagesFor(0, 50)).toBe(1);
    expect(totalPagesFor(101, 50)).toBe(3);
    expect(pageRange(1, 50, 0)).toEqual({ from: 0, to: 0 });
    expect(pageRange(1, 50, 120)).toEqual({ from: 1, to: 50 });
    expect(pageRange(3, 50, 120)).toEqual({ from: 101, to: 120 });
    expect(pageRange(9, 50, 120)).toEqual({ from: 101, to: 120 });
  });

  test("URL: leitura e escrita omitem padrões", () => {
    const read = readPaginationFromSearch(new URLSearchParams("page=2&page_size=100"));
    expect(read).toEqual({ page: 2, pageSize: 100 });
    expect(readPaginationFromSearch(new URLSearchParams("page_size=7"))).toEqual({ page: 1, pageSize: 50 });
    const out = writePaginationToSearch(new URLSearchParams("q=a&page=4"), { page: 1, pageSize: 200 });
    expect(out.toString()).toBe("q=a&page_size=200");
  });
});
