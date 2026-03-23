# Matrix Lark Bridge

Matrix Lark Bridge — 飞书 & 微信消息桥接服务。

## 构建说明

本项目是 pnpm monorepo，使用 TypeScript **composite** + **project references** 构建策略。

### 包依赖关系

```
shared (composite, 无 workspace 依赖)
wechat-sdk (composite, 独立包, 无 workspace 依赖)
bridge (composite, references shared + wechat-sdk, 依赖 shared + wechat-sdk)
manager (references shared + wechat-sdk, 依赖 shared + wechat-sdk, 无 composite)
deepforge (独立包, 无 composite)
```

- `bridge` 的 `tsconfig.json` 通过 `"references": [{ "path": "../shared" }, { "path": "../wechat-sdk" }]` 引用 `shared` 和 `wechat-sdk`，同时 `package.json` 依赖 `@mlb/shared` 和 `@mlb/wechat-sdk`。
- `manager` 的 `tsconfig.json` 通过 `"references": [{ "path": "../shared" }, { "path": "../wechat-sdk" }]` 引用 `shared` 和 `wechat-sdk`，同时 `package.json` 依赖 `@mlb/shared` 和 `@mlb/wechat-sdk`。注意：manager 没有 `composite: true`，因此不在根 `tsc --build` 增量编译链中。
- `wechat-sdk` 是完全独立的包，无任何 workspace 依赖。
- 根 `tsconfig.json` 的 `references` 仅包含有 `composite: true` 的包：`shared`、`wechat-sdk`、`bridge`。`deepforge` 和 `manager` 没有 `composite: true`，不在根 references 中（否则 `tsc --build` 会报 TS6059）。

### 修改 shared / wechat-sdk 后必须重建

每次修改 `packages/shared/src/` 下的文件后，**必须先重建 shared**，然后再编译下游包（bridge、manager）。否则下游包的 `tsc` 仍会使用 `shared/dist/` 中的旧类型声明，导致编译错误或类型不一致。

同理，每次修改 `packages/wechat-sdk/src/` 下的文件后，**必须先重建 wechat-sdk**，然后再编译下游包（bridge、manager）。两者均依赖 `wechat-sdk/dist/` 中的编译产物，未重建会导致类型不一致。

重建方式（二选一）：

```bash
# 方式 1：串行全量构建（推荐，已内置正确顺序）
pnpm run build

# 方式 2：单独重建上游包
pnpm run build:shared      # 修改 shared 后
pnpm run build:wechat-sdk  # 修改 wechat-sdk 后
```

### 常用命令

```bash
# 安装依赖
pnpm install

# 全量构建（串行：shared → wechat-sdk → bridge → deepforge → manager）
pnpm run build

# 类型检查（仅检查 bridge，不生成文件）
npx tsc --noEmit --project packages/bridge/tsconfig.json

# 运行微信桥接测试
cd packages/bridge && npx tsx --test tests/wechat/*.test.ts

# 清理 + 重建
pnpm run rebuild
```
