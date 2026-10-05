import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/db.js";
import { startServer } from "../src/server.js";
import { AppError } from "../src/errors.js";

const DEMO = [
  { id: "A", rows: 10, cols: 30 },
  { id: "B", rows: 30, cols: 5 },
  { id: "C", rows: 5, cols: 60 },
];

test("导入、版本与快照不可变", () => {
  const store = new Store(":memory:");
  const first = store.importChain("t", null, DEMO);
  assert.equal(first.version.version, 1);

  const same = store.importChain(null, first.chain.id, DEMO);
  assert.equal(same.reused, true);
  assert.equal(same.version.version, 1);

  const changed = store.importChain(null, first.chain.id, [
    { id: "A", rows: 10, cols: 30 },
    { id: "B", rows: 30, cols: 5 },
    { id: "C", rows: 5, cols: 7 },
  ]);
  assert.equal(changed.reused, false);
  assert.equal(changed.version.version, 2);

  // 历史版本仍按原编号查询，尺寸未被覆盖
  const v1 = store.getVersion(first.chain.id, 1);
  assert.equal(v1.matrices[2].cols, 60);
  const r1 = store.getResult(first.chain.id, 1);
  assert.equal(r1.optimalCost, "4500");
  const r2 = store.getResult(first.chain.id, 2);
  assert.notEqual(r2.optimalCost, "4500");
  store.close();
});

test("失败输入不保存成成功规划", () => {
  const store = new Store(":memory:");
  assert.throws(
    () => store.importChain("bad", null, [{ id: "A", rows: 2, cols: 3 }, { id: "B", rows: 9, cols: 1 }]),
    (e) => (e as AppError).code === "INCOMPATIBLE_BOUNDARY",
  );
  assert.equal(store.listChains().length, 0);
  store.close();
});

test("区间表分页覆盖全部区间", () => {
  const store = new Store(":memory:");
  const { chain } = store.importChain("t", null, DEMO);
  const page1 = store.getTable(chain.id, 1, 0, 2);
  const page2 = store.getTable(chain.id, 1, 2, 2);
  assert.equal(page1.total, 3);
  assert.equal(page1.entries.length + page2.entries.length, 3);
  store.close();
});

test("核验报告持久化", () => {
  const store = new Store(":memory:");
  const { chain } = store.importChain("t", null, DEMO);
  const candidate = { left: { leaf: "A" }, right: { left: { leaf: "B" }, right: { leaf: "C" } } };
  const id = store.saveVerification(chain.id, 1, candidate, {
    valid: true, errors: [], cost: "27000", optimalCost: "4500", diff: "22500", isOptimal: false,
  });
  const list = store.listVerifications(chain.id, 1);
  assert.equal(list.length, 1);
  assert.equal((list[0] as { id: number }).id, id);
  store.close();
});

test("HTTP API 端到端", async () => {
  const store = new Store(":memory:");
  const running = await startServer(store, 0);
  const port = running.port;
  const base = `http://127.0.0.1:${port}`;

  const created = await fetch(`${base}/chains`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "api", matrices: DEMO }),
  });
  assert.equal(created.status, 201);
  const createdBody = (await created.json()) as { chain: { id: number }; optimalCost: string };
  assert.equal(createdBody.optimalCost, "4500");
  const cid = createdBody.chain.id;

  const result = await (await fetch(`${base}/chains/${cid}/versions/1/result`)).json() as {
    expression: string; steps: unknown[];
  };
  assert.equal(result.expression, "((A x B) x C)");
  assert.equal(result.steps.length, 2);

  const explain = await (await fetch(`${base}/chains/${cid}/versions/1/explain?i=0&j=2`)).json() as {
    chosenK: number; candidates: unknown[];
  };
  assert.equal(explain.chosenK, 1);
  assert.equal(explain.candidates.length, 2);

  const verify = await (await fetch(`${base}/chains/${cid}/versions/1/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ plan: { left: { leaf: "A" }, right: { left: { leaf: "B" }, right: { leaf: "C" } } } }),
  })).json() as { report: { valid: boolean; diff: string } };
  assert.equal(verify.report.valid, true);
  assert.equal(verify.report.diff, "22500");

  const baseline = await (await fetch(`${base}/chains/${cid}/versions/1/baseline`)).json() as {
    leftAssocCost: string; optimalCost: string;
  };
  assert.equal(baseline.leftAssocCost, "4500");

  const bad = await fetch(`${base}/chains`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ matrices: [] }),
  });
  assert.equal(bad.status, 400);
  const badBody = (await bad.json()) as { error: { code: string } };
  assert.equal(badBody.error.code, "EMPTY_CHAIN");

  const missing = await fetch(`${base}/chains/999/versions/1/result`);
  assert.equal(missing.status, 404);

  const exp = await (await fetch(`${base}/chains/${cid}/versions/1/export`)).json() as {
    verifications: unknown[];
  };
  assert.equal(exp.verifications.length, 1);
  running.server.closeAllConnections();
  running.server.close();
  store.close();
});



