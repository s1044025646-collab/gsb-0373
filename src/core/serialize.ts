/**
 * 所有对外 JSON 中的 bigint 一律转成十进制字符串，避免超过 Number 安全整数而失真。
 */
export function serialize(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = serialize(v);
    return out;
  }
  return value;
}

/** 把来自 JSON 的输入里 rows/cols（数字或字符串）保留为原值，交给校验层转 BigInt */
export function parseMatrixInput(body: unknown): { id: string; rows: unknown; cols: unknown }[] {
  if (!body || typeof body !== "object") {
    throw new Error("请求体必须是对象");
  }
  const obj = body as Record<string, unknown>;
  const list = obj.matrices ?? obj.chain;
  if (!Array.isArray(list)) {
    throw new Error("请求体需要 matrices 数组，元素形如 {id, rows, cols}");
  }
  return list.map((m) => {
    const r = m as Record<string, unknown>;
    return { id: r.id, rows: r.rows, cols: r.cols };
  });
}
