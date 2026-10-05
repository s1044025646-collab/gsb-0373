# 矩阵链乘法括号规划与标量代价解释后端（mcm-planner）

纯后端项目：TypeScript + Node.js + SQLite（`node:sqlite`，无原生依赖、无外部服务）。
提供 HTTP API 与 CLI，用于矩阵链乘法的**最少标量乘法次数规划**、计划解释与独立核验。

## 成本模型

- 输入是一串带唯一编号的矩阵尺寸（`id, rows, cols`），矩阵顺序固定，只允许通过加括号改变结合顺序。
- 相邻矩阵必须相容：矩阵 i 的列数必须等于矩阵 i+1 的行数，否则报错并指出具体边界，绝不悄悄转置。
- 一个 `a x b` 矩阵与 `b x c` 矩阵相乘，计 `a * b * c` 次标量乘法。
- 单个矩阵代价为 0；空链明确拒绝。
- 所有计数使用 BigInt，API/CLI 返回十进制字符串，超过 `Number.MAX_SAFE_INTEGER` 也不失真。
- 只规划计算顺序：不优化矩阵内部算法、不做稀疏性分析、并行调度或内存峰值优化；API 不接收矩阵元素。

## 算法

自行实现的区间动态规划（`src/core.ts`）：

- `cost[i][j] = min over k in [i, j) of cost[i][k] + cost[k+1][j] + p[i]*p[k+1]*p[j+1]`
- 多个 k 同样最优时选择**最小的 k**，子区间递归采用同一规则，输出完全确定。
- 并列分割点会被记录并可在 `explain` 中查看，但不枚举所有最优树、不计算排名。
- 不使用任何现成优化库，也不用"从左到右"或"合并最小局部乘积"之类的贪心冒充全局最优。

## 限制（公开常量）

- 链长度上限：`60`（`MAX_CHAIN_LENGTH`）
- 单个尺寸上限：`1_000_000_000`（`MAX_DIMENSION`）
- 区间表与解释接口分页/限量（`limit` 最大 500），但最优结果始终覆盖整条链。

## 安装、构建、测试、启动

```powershell
npm install        # 安装 typescript / @types/node（仅开发依赖）
npm run build      # 编译到 dist/
npm test           # 构建并运行全部测试（含 <=6 矩阵的独立枚举核对）
npm start          # 启动 API（默认端口 0 = 自动选择空闲端口，控制台打印实际端口）
npm run demo       # 运行内置演示
```

要求：Node.js >= 22.5（使用内置 `node:sqlite`，会打印 ExperimentalWarning，属正常）。
Windows 本地运行，不需要 Docker / WSL / 外部 API。

数据保存在项目内 `data/mcm.sqlite`（可用环境变量 `MCM_DATA_DIR` 覆盖）。重启后历史链、版本、
DP 结果与核验报告仍可查询；校验失败的输入不会写入数据库。

## CLI 命令

```powershell
node dist/src/cli.js serve [--port N]                  # 启动 HTTP API
node dist/src/cli.js import --file dims.json [--name 名称] [--chain 链ID]
node dist/src/cli.js list                              # 列出所有链
node dist/src/cli.js versions --chain ID               # 列出版本
node dist/src/cli.js result --chain ID [--version V]   # 最优结果 + 括号表达式 + 后序步骤
node dist/src/cli.js table --chain ID [--offset O] [--limit L]
node dist/src/cli.js explain --chain ID --i I --j J    # 解释区间分割（0-based）
node dist/src/cli.js verify --chain ID --plan plan.json
node dist/src/cli.js baseline --chain ID               # 左结合基准对比
node dist/src/cli.js export --chain ID [--out file.json]
node dist/src/cli.js demo
```

尺寸文件格式（`examples/dims.json`）：

```json
[
  {"id": "A", "rows": 10, "cols": 30},
  {"id": "B", "rows": 30, "cols": 5},
  {"id": "C", "rows": 5, "cols": 60}
]
```

候选计划文件格式（`examples/plan-right.json`）：叶子为 `{"leaf": "编号"}`，内部节点为
`{"left": ..., "right": ...}`。

导入时尺寸快照不变则复用最新版本；任何尺寸变化都会生成**新版本**，历史版本按原编号查询，
不会被覆盖。

## HTTP API

默认监听 `127.0.0.1`，`--port 0` 自动选择空闲端口。所有响应为 JSON。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/` | 服务信息、公开限制、端点列表 |
| GET | `/chains` | 列出所有链 |
| POST | `/chains` | `{name?, matrices}` 导入并计算最优计划 |
| POST | `/chains/:id/versions` | `{matrices}` 为已有链导入新快照（变化才生成新版本） |
| GET | `/chains/:id/versions` | 列出版本 |
| GET | `/chains/:id/versions/:v/result` | 最优代价、括号表达式、二叉计划树、后序步骤、左结合基准 |
| GET | `/chains/:id/versions/:v/table?offset=&limit=` | 区间 DP 表（分页） |
| GET | `/chains/:id/versions/:v/explain?i=&j=` | 每个分割点 k 的左/右/本次/总代价明细、选中与并列 |
| POST | `/chains/:id/versions/:v/verify` | `{plan}` 核验候选计划，报告持久化 |
| GET | `/chains/:id/versions/:v/verifications` | 历史核验报告 |
| GET | `/chains/:id/versions/:v/baseline` | 左结合基准与最优值对比 |
| GET | `/chains/:id/versions/:v/export` | 导出链、版本、结果与核验报告 |

错误响应：`{"error": {"code": "...", "message": "...", "details": ...}}`，HTTP 400（参数/校验）
或 404（不存在）。错误码包括：`EMPTY_CHAIN`、`CHAIN_TOO_LONG`、`DUPLICATE_MATRIX_ID`、
`INVALID_DIMENSION`、`DIMENSION_LIMIT`、`INCOMPATIBLE_BOUNDARY`、`NOT_FOUND`、`BAD_REQUEST`、
`PLAN_UNKNOWN_LEAF`、`PLAN_DUPLICATE_LEAF`、`PLAN_MISSING_LEAF`、`PLAN_ORDER_MISMATCH`、
`PLAN_INCOMPATIBLE`、`PLAN_MALFORMED`。

## 候选计划核验语义

核验独立重新核算，不复用 DP 结果：

- 检查未知叶子、重复叶子、缺少矩阵、中序顺序是否与原链一致、每次合并的维度相容性；
- 全部通过则按计划重算总代价并与已存最优值对照；
- **合法但更贵的计划是 valid=true、isOptimal=false，并给出 `diff`（多出的标量乘法次数）**，
  不会被误判为无效。

## 演示说明（10x30, 30x5, 5x60）

- 左结合 `((A x B) x C)`：`10*30*5 + 10*5*60 = 1500 + 3000 = 4500`
- 右结合 `(A x (B x C))`：`30*5*60 + 10*30*60 = 9000 + 18000 = 27000`

两种结合的最终结果都是 `10 x 60`，但中间结果尺寸不同，总代价相差 6 倍——局部尺寸大小或
最终结果大小都不能代表总计算量，必须全局比较所有分割点。`npm run demo` 还会演示 4 个
`10 x 10` 矩阵的并列最优（k = 0,1,2 等价）与"取最小 k"的稳定分割规则。

## 测试

`npm test` 覆盖：单矩阵、两矩阵、不同长度、超安全整数代价（BigInt 精度）、非法维度、
不相容边界、超长链、重复编号、候选计划的未知/重复/缺失/顺序篡改/不兼容、合法但非最优
计划的代价差、计划节点代价之和等于报告值、后序步骤叶子恰好一次且保持顺序、
版本快照不可变、失败输入不落库、区间表分页、HTTP 端到端。
对不超过 6 个矩阵的多条链，用**独立枚举全部括号结构**（非 DP 递推）核对最优值与规范计划。

## 已知限制

- `node:sqlite` 在 Node 25 仍标记为实验特性（打印警告，功能稳定可用）。
- 区间表与解释接口分页，单次 `limit` 上限 500。
- API 仅监听本机回环地址，无认证，面向本地使用。
