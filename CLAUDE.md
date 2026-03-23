# MLB (Matrix Lark Bridge)

## Build

- Monorepo: pnpm workspace, packages under `packages/`
- Build all: `pnpm run build` (shared → wechat-sdk → bridge → deepforge → manager)
- Build + DMG: `pnpm run dist`
- Dev mode: `pnpm run dev:manager`

## Packaging (electron-builder)

### electron.vite.config.ts — external 规则

`packages/manager/electron.vite.config.ts` 的 `main.build.rollupOptions.external` 只允许 `['electron']`。

**禁止**将任何 `@mlb/*` workspace 包加入 external 列表。workspace 包必须被 electron-vite inline 到 dist/main/index.js，否则打包后的 .app 找不到模块会直接崩溃（Uncaught Error: Cannot find module）。

### bridge / deepforge bundling

bridge 和 deepforge 通过 `scripts/bundle-bridge.mjs` 用 esbuild 打成单文件，放入 extraResources。新增类似的独立进程包时需要同步更新该脚本和 `electron-builder.yml`。

## Version bumps

发版时所有 package.json 版本号必须一致（root + packages/*）。
