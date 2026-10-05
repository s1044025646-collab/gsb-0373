import fs from "node:fs";
import { AppError } from "./errors.js";
import { explainSplit, validateChain, verifyCandidate, MAX_CHAIN_LENGTH, MAX_DIMENSION } from "./core.js";
import { Store, defaultDbPath } from "./db.js";
import { startServer } from "./server.js";
import type { Step } from "./types.js";

interface Args {
  _: string[];
  [key: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function num(args: Args, key: string, required = true): number {
  const v = args[key];
  if (v === undefined || v === true) {
    if (required) throw new AppError("BAD_REQUEST", `缺少参数 --${key}`);
    return NaN;
  }
  const n = Number(v);
  if (!Number.isInteger(n)) throw new AppError("BAD_REQUEST", `--${key} 必须是整数，收到 "${v}"`);
  return n;
}

function str(args: Args, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    throw new AppError("BAD_REQUEST", `无法读取 JSON 文件 ${file}: ${String(e)}`);
  }
}

function printSteps(steps: Step[]): void {
  for (const s of steps) {
    console.log(
      `  步骤 ${s.step}: ${s.left} x ${s.right} -> ${s.resultRows}x${s.resultCols}，本次代价 ${s.cost}`,
    );
  }
}

function showResult(store: Store, chainId: number, version: number): void {
  const r = store.getResult(chainId, version);
  console.log(`链 ${chainId} 版本 ${version}`);
  console.log(`矩阵: ${JSON.stringify(r.version.matrices)}`);
  console.log(`最优标量乘法次数: ${r.optimalCost}`);
  console.log(`括号表达式: ${r.expression}`);
  console.log(`左结合基准代价: ${r.leftAssocCost}（节省 ${BigInt(r.leftAssocCost) - BigInt(r.optimalCost)}）`);
  console.log("后序执行计划:");
  printSteps(r.steps as Step[]);
}

const HELP = `矩阵链乘法规划器 CLI

用法: mcm <命令> [参数]

命令:
  serve [--port N]                 启动 HTTP API（默认端口 0 = 自动选择空闲端口）
  import --file dims.json [--name 名称] [--chain 链ID]
                                   导入尺寸链并计算最优计划；--chain 用于给已有链生成新版本
  list                             列出所有链及版本数
  versions --chain ID              列出某链的全部版本
  result --chain ID [--version V]  查看最优结果、括号表达式与后序步骤（默认最新版本）
  table --chain ID [--version V] [--offset O] [--limit L]
                                   查看区间 DP 表（分页，默认 limit 50）
  explain --chain ID --i I --j J [--version V]
                                   解释区间 [i,j]（0-based）的分割选择
  verify --chain ID --plan plan.json [--version V]
                                   核验候选计划（{leaf:"A"} 或 {left:.., right:..}）
  baseline --chain ID [--version V] 对比左结合基准
  export --chain ID [--version V] [--out file.json]
                                   导出链、结果与核验报告
  demo                             运行内置演示

限制: 链长度 <= ${MAX_CHAIN_LENGTH}，尺寸 <= ${MAX_DIMENSION}
数据目录: 项目内 data/（可用环境变量 MCM_DATA_DIR 覆盖）
`;

function latestVersion(store: Store, chainId: number, args: Args): number {
  const v = str(args, "version");
  if (v !== undefined) return num(args, "version");
  const versions = store.listVersions(chainId);
  return versions[versions.length - 1].version;
}

function runDemo(store: Store): void {
  console.log("=== 演示 1：10x30, 30x5, 5x60 ===");
  const demo1 = [
    { id: "A", rows: 10, cols: 30 },
    { id: "B", rows: 30, cols: 5 },
    { id: "C", rows: 5, cols: 60 },
  ];
  const { chain, version } = store.importChain("demo-1", null, demo1);
  const r = store.getResult(chain.id, version.version);
  console.log(`括号表达式: ${r.expression}`);
  console.log(`最优代价: ${r.optimalCost}（左结合 (AxB)xC 为 ${r.leftAssocCost}）`);
  console.log(
    "说明：左结合先算 10x30 乘 30x5（代价 10*30*5=1500），再乘 5x60（代价 10*5*60=3000），共 4500；",
  );
  console.log(
    "      右结合先算 30x5 乘 5x60（代价 30*5*60=9000），再算 10x30 乘 30x60（代价 10*30*60=18000），共 27000。",
  );
  console.log(
    "      局部尺寸更小或最终结果更小都不代表总代价更低：两种结合方式的最终结果都是 10x60，",
  );
  console.log("      但中间结果的尺寸不同，累计标量乘法次数相差 6 倍。只有全局比较所有分割点才能得到最优。");
  console.log("后序执行计划:");
  printSteps(r.steps as Step[]);

  console.log("");
  console.log("=== 演示 2：同尺寸矩阵的并列最优与稳定分割 ===");
  const demo2 = [
    { id: "M1", rows: 10, cols: 10 },
    { id: "M2", rows: 10, cols: 10 },
    { id: "M3", rows: 10, cols: 10 },
    { id: "M4", rows: 10, cols: 10 },
  ];
  const d2 = store.importChain("demo-2", null, demo2);
  const r2 = store.getResult(d2.chain.id, d2.version.version);
  console.log(`括号表达式: ${r2.expression}`);
  console.log(`最优代价: ${r2.optimalCost}`);
  const { dp } = store.getDpForExplain(d2.chain.id, d2.version.version);
  const chain2 = validateChain(demo2);
  const ex = explainSplit(chain2, dp, 0, 3);
  console.log(`整链区间 [0,3] 的并列最优分割点 k = [${ex.tiedKs.join(", ")}]，按规则选择最小 k = ${ex.chosenK}`);
  for (const c of ex.candidates) {
    console.log(
      `  k=${c.k}: 左 ${c.leftCost} + 右 ${c.rightCost} + 本次 ${c.mulCost} = ${c.total}${c.chosen ? "  <== 选中" : c.tied ? "  (并列)" : ""}`,
    );
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0];
  if (!cmd || cmd === "help" || args.help) {
    console.log(HELP);
    return;
  }
  const store = new Store(defaultDbPath());
  try {
    switch (cmd) {
      case "serve": {
        const port = args.port === undefined ? 0 : num(args, "port");
        const running = await startServer(store, port);
        console.log(`API 已启动: http://127.0.0.1:${running.port}/ （Ctrl+C 停止）`);
        return; // 保持进程
      }
      case "import": {
        const file = str(args, "file");
        if (!file) throw new AppError("BAD_REQUEST", "import 需要 --file");
        const data = readJson(file);
        const matrices = Array.isArray(data) ? data : (data as Record<string, unknown>).matrices;
        const chainId = args.chain !== undefined ? num(args, "chain") : null;
        const { chain, version, reused } = store.importChain(str(args, "name") ?? null, chainId, matrices);
        console.log(
          reused
            ? `尺寸快照未变化，复用链 ${chain.id} 版本 ${version.version}`
            : `已保存链 ${chain.id} 版本 ${version.version}`,
        );
        showResult(store, chain.id, version.version);
        break;
      }
      case "list": {
        for (const c of store.listChains()) {
          console.log(`链 ${c.id}: ${c.name}（${c.versions} 个版本，创建于 ${c.created_at}）`);
        }
        break;
      }
      case "versions": {
        const chainId = num(args, "chain");
        for (const v of store.listVersions(chainId)) {
          console.log(`版本 ${v.version}: ${JSON.stringify(v.matrices)}（${v.created_at}）`);
        }
        break;
      }
      case "result": {
        showResult(store, num(args, "chain"), latestVersion(store, num(args, "chain"), args));
        break;
      }
      case "table": {
        const chainId = num(args, "chain");
        const v = latestVersion(store, chainId, args);
        const offset = args.offset !== undefined ? num(args, "offset") : 0;
        const limit = args.limit !== undefined ? num(args, "limit") : 50;
        const t = store.getTable(chainId, v, offset, limit);
        console.log(`区间表（共 ${t.total} 项，显示 ${t.offset}..${t.offset + t.entries.length - 1}）:`);
        for (const e of t.entries as { i: number; j: number; cost: string; splitK: number; tiedKs: number[] }[]) {
          console.log(`  [${e.i},${e.j}] 最优=${e.cost} 分割k=${e.splitK} 并列=[${e.tiedKs.join(",")}]`);
        }
        break;
      }
      case "explain": {
        const chainId = num(args, "chain");
        const v = latestVersion(store, chainId, args);
        const i = num(args, "i");
        const j = num(args, "j");
        const { dp } = store.getDpForExplain(chainId, v);
        const version = store.getVersion(chainId, v);
        const ex = explainSplit(validateChain(version.matrices), dp, i, j);
        console.log(`区间 [${i},${j}] 最优代价 ${ex.best}，选中 k=${ex.chosenK}，并列 k=[${ex.tiedKs.join(",")}]`);
        for (const c of ex.candidates) {
          console.log(
            `  k=${c.k} (${c.leftId} | ${c.rightId}): ${c.leftCost} + ${c.rightCost} + ${c.mulCost} = ${c.total}${c.chosen ? "  <== 选中" : c.tied ? "  (并列)" : ""}`,
          );
        }
        break;
      }
      case "verify": {
        const chainId = num(args, "chain");
        const v = latestVersion(store, chainId, args);
        const file = str(args, "plan");
        if (!file) throw new AppError("BAD_REQUEST", "verify 需要 --plan");
        const candidate = readJson(file);
        const version = store.getVersion(chainId, v);
        const result = store.getResult(chainId, v);
        const report = verifyCandidate(validateChain(version.matrices), BigInt(result.optimalCost), candidate);
        const id = store.saveVerification(chainId, v, candidate, report);
        console.log(`核验报告 #${id}:`);
        console.log(JSON.stringify(report, null, 2));
        if (report.valid && !report.isOptimal) {
          console.log(`计划合法但非最优，比最优值多 ${report.diff} 次标量乘法。`);
        }
        break;
      }
      case "baseline": {
        const chainId = num(args, "chain");
        const v = latestVersion(store, chainId, args);
        const r = store.getResult(chainId, v);
        console.log(`左结合基准: ${r.leftAssocCost}，最优: ${r.optimalCost}，节省: ${BigInt(r.leftAssocCost) - BigInt(r.optimalCost)}`);
        break;
      }
      case "export": {
        const chainId = num(args, "chain");
        const v = latestVersion(store, chainId, args);
        const out = {
          chain: store.getChain(chainId),
          result: store.getResult(chainId, v),
          verifications: store.listVerifications(chainId, v),
        };
        const json = JSON.stringify(out, null, 2);
        const file = str(args, "out");
        if (file) {
          fs.writeFileSync(file, json);
          console.log(`已导出到 ${file}`);
        } else {
          console.log(json);
        }
        break;
      }
      case "demo": {
        runDemo(store);
        break;
      }
      default:
        throw new AppError("BAD_REQUEST", `未知命令 "${cmd}"，运行不带参数查看帮助`);
    }
  } finally {
    if (args._[0] !== "serve") store.close();
  }
}

main().catch((e: unknown) => {
  if (e instanceof AppError) {
    console.error(`错误 [${e.code}]: ${e.message}`);
  } else {
    console.error(e);
  }
  process.exitCode = 1;
});


