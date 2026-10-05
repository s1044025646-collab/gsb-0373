import http from "node:http";
import { AppError } from "./errors.js";
import { explainSplit, verifyCandidate, validateChain, MAX_CHAIN_LENGTH, MAX_DIMENSION } from "./core.js";
import { Store } from "./db.js";

const MAX_BODY = 1024 * 1024;

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(json);
}

function sendError(res: http.ServerResponse, err: unknown): void {
  if (err instanceof AppError) {
    const status = err.code === "NOT_FOUND" ? 404 : 400;
    send(res, status, { error: { code: err.code, message: err.message, details: err.details ?? null } });
  } else {
    send(res, 500, { error: { code: "INTERNAL", message: String(err) } });
  }
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new AppError("BAD_REQUEST", "请求体过大"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new AppError("BAD_REQUEST", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

function parseId(s: string | undefined, what: string): number {
  const n = Number(s);
  if (!Number.isInteger(n) || n <= 0) {
    throw new AppError("BAD_REQUEST", `${what} 必须是正整数，收到 "${s}"`);
  }
  return n;
}

export function createServer(store: Store): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const parts = url.pathname.split("/").filter(Boolean);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/") {
        return send(res, 200, {
          service: "mcm-planner",
          limits: { maxChainLength: MAX_CHAIN_LENGTH, maxDimension: MAX_DIMENSION },
          endpoints: [
            "GET /chains",
            "POST /chains {name?, matrices:[{id,rows,cols}]}",
            "POST /chains/:id/versions {matrices}",
            "GET /chains/:id/versions",
            "GET /chains/:id/versions/:v/result",
            "GET /chains/:id/versions/:v/table?offset=&limit=",
            "GET /chains/:id/versions/:v/explain?i=&j=",
            "POST /chains/:id/versions/:v/verify {plan}",
            "GET /chains/:id/versions/:v/verifications",
            "GET /chains/:id/versions/:v/baseline",
            "GET /chains/:id/versions/:v/export",
          ],
        });
      }

      if (parts[0] === "chains" && parts.length === 1 && method === "GET") {
        return send(res, 200, { chains: store.listChains() });
      }

      if (parts[0] === "chains" && parts.length === 1 && method === "POST") {
        const body = (await readBody(req)) as Record<string, unknown>;
        const { chain, version, reused } = store.importChain(
          typeof body.name === "string" ? body.name : null,
          null,
          body.matrices,
        );
        const result = store.getResult(chain.id, version.version);
        return send(res, 201, { chain, version: version.version, reused, optimalCost: result.optimalCost, expression: result.expression });
      }

      if (parts[0] === "chains" && parts.length >= 2) {
        const chainId = parseId(parts[1], "链编号");

        if (parts.length === 3 && parts[2] === "versions" && method === "POST") {
          const body = (await readBody(req)) as Record<string, unknown>;
          const { chain, version, reused } = store.importChain(null, chainId, body.matrices);
          return send(res, reused ? 200 : 201, { chain, version: version.version, reused });
        }
        if (parts.length === 3 && parts[2] === "versions" && method === "GET") {
          return send(res, 200, { versions: store.listVersions(chainId) });
        }
        if (parts.length >= 5 && parts[2] === "versions") {
          const v = parseId(parts[3], "版本号");
          const sub = parts[4];

          if (sub === "result" && method === "GET") {
            return send(res, 200, store.getResult(chainId, v));
          }
          if (sub === "table" && method === "GET") {
            const offset = Math.max(0, Number(url.searchParams.get("offset") ?? 0) || 0);
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? 50) || 50));
            return send(res, 200, store.getTable(chainId, v, offset, limit));
          }
          if (sub === "explain" && method === "GET") {
            const i = Number(url.searchParams.get("i"));
            const j = Number(url.searchParams.get("j"));
            if (!Number.isInteger(i) || !Number.isInteger(j)) {
              throw new AppError("BAD_REQUEST", "explain 需要整数参数 i 和 j（0-based）");
            }
            const { dp } = store.getDpForExplain(chainId, v);
            const version = store.getVersion(chainId, v);
            const chain = validateChain(version.matrices);
            return send(res, 200, explainSplit(chain, dp, i, j));
          }
          if (sub === "verify" && method === "POST") {
            const body = (await readBody(req)) as Record<string, unknown>;
            if (!("plan" in body)) throw new AppError("BAD_REQUEST", "缺少 plan 字段");
            const version = store.getVersion(chainId, v);
            const chain = validateChain(version.matrices);
            const result = store.getResult(chainId, v);
            const report = verifyCandidate(chain, BigInt(result.optimalCost), body.plan);
            const id = store.saveVerification(chainId, v, body.plan, report);
            return send(res, 200, { verificationId: id, report });
          }
          if (sub === "verifications" && method === "GET") {
            return send(res, 200, { verifications: store.listVerifications(chainId, v) });
          }
          if (sub === "baseline" && method === "GET") {
            const result = store.getResult(chainId, v);
            return send(res, 200, {
              leftAssocCost: result.leftAssocCost,
              optimalCost: result.optimalCost,
              saving: (BigInt(result.leftAssocCost) - BigInt(result.optimalCost)).toString(),
            });
          }
          if (sub === "export" && method === "GET") {
            const result = store.getResult(chainId, v);
            return send(res, 200, {
              chain: store.getChain(chainId),
              version: result.version,
              result,
              verifications: store.listVerifications(chainId, v),
            });
          }
        }
      }

      throw new AppError("NOT_FOUND", `路由不存在：${method} ${url.pathname}`);
    } catch (err) {
      sendError(res, err);
    }
  });
}

export interface RunningServer {
  server: http.Server;
  port: number;
}

// 默认端口 0 = 让操作系统分配空闲端口
export function startServer(store: Store, port: number): Promise<RunningServer> {
  const server = createServer(store);
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve({ server, port: typeof addr === "object" && addr ? addr.port : port });
    });
  });
}
