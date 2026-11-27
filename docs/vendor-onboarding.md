# 厂商小程序快速开始

[English](vendor-onboarding.en.md)

准备 Node.js 24 和包含宿主模拟参数的新版 DevTools 预览包。从预览交付物中取得 Agent 和 packer 的两个 npm 归档，用一个独立工具目录安装。

```sh
mkdir -p vendor-tooling
npm install --prefix ./vendor-tooling /absolute/path/to/sonofmagic-container-manifest-0.1.0.tgz /absolute/path/to/weapp-container-agent-0.1.0.tgz
export PATH="$PWD/vendor-tooling/node_modules/.bin:$PATH"
weapp-container-agent create --project ./my-mini-program --name "我的品牌"
cd my-mini-program
npm install
```

修改 `src/app.json` 的导航标题和颜色，在 `src/pages/index/brand.js` 编辑首页内容与 Logo 路径。品牌图片放到 `src/assets/`，把 `logo` 设为 `/assets/logo.png` 等应用内路径。页面和全局配色分别在首页 WXSS 和 `src/app.wxss`。

```sh
weapp-container-agent preview start --project . --simulator-bin /absolute/path/to/bin/weapp-simulator --host-fixtures preview/host-fixtures.json
weapp-container-agent preview status --project .
weapp-container-agent build --project . --out ../portable-pack --json
weapp-container-agent preview stop --project .
```

打开预览输出中的 `url`。模拟文件按方法名配置，例如 `{"company.getProfile":{"resolve":{"displayName":"预览用户"}}}`，或 `{"company.getProfile":{"reject":"Profile access denied"}}`。更改模拟文件后重启预览。编译失败时可从状态给出的日志路径查看原因，保存修复后由预览重新构建。

`build --out` 要求目标目录尚不存在。记录输出中的 `integrityRoot`，并将整个 pack 目录交给宿主。宿主在加载前注册 `company.getProfile`，由应用处理身份和权限。 [Android 和 iOS 可运行示例](../examples/hosts/vendor-onboarding/README.md)

已有项目先运行 `weapp-container-agent inspect --project /path/to/project --json`。查看 `diagnostics` 的修复提示和 `compatibility.findings` 的文件、行号及兼容性证据。按项目依赖安装 weapp-vite，再用同一套预览和出包命令。只预览已有源码也可直接在 DevTools 中打开项目目录。
