import { test, expect } from "bun:test";
import { checkWriteAllowed, listBlockedPaths } from "../src/app/write-scope.ts";

test("write scope blocks workflows and reviewerc", () => {
  expect(checkWriteAllowed(".github/workflows/ci.yml").allowed).toBe(false);
  expect(checkWriteAllowed(".reviewerc").allowed).toBe(false);
});

test("write scope respects include/exclude", () => {
  const scope = { include: ["docs/**"], exclude: ["docs/private/**"] };
  expect(checkWriteAllowed("docs/readme.md", scope).allowed).toBe(true);
  expect(checkWriteAllowed("docs/private/secret.md", scope).allowed).toBe(false);
  expect(checkWriteAllowed("src/index.ts", scope).allowed).toBe(false);
});

test("listBlockedPaths returns disallowed files", () => {
  const scope = { include: ["docs/**"] };
  const blocked = listBlockedPaths(["docs/a.md", "src/a.ts"], scope);
  expect(blocked).toEqual(["src/a.ts"]);
});
