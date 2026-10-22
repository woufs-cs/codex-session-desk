# macOS 预览版使用指南

状态：0.16.0-beta.1。macOS 适配代码、启动脚本及打包入口已提供，但尚未在真实 Mac 验证。现有 Windows 0.15.6 Release 不含此版本。请先用测试对话验证跨机同步。

## 直接运行界面

1. 在 Mac 安装 Node.js 24 或更新版本，以及 Codex 桌面端和 Codex CLI。CLI 是应用连接程序，不需要通过 CLI 创建对话。
2. 解压 `SessionDesk-0.16.0-beta.1-mac-source.zip` 到一个固定目录；不要从 Windows 复制 node_modules。
3. 打开终端，输入 `cd `，把解压后的文件夹拖入终端，回车，然后执行：

```bash
bash scripts/start-mac.sh
```

首次启动会通过 npm ci 下载锁定的依赖，需要网络；以后运行同一条命令即可。它启动完整图形界面，不是另一套同步协议，也不需要手工输入导入导出命令。不要使用 sudo 运行应用。

## 连接与接收

1. 应用中填写与 Windows 相同的 WebDAV 地址、账号及应用密码。也可选择坚果云在 Mac 上已经同步的独立同步库文件夹。
2. 点击自动检测 Codex CLI；找不到时手工选择原生 `codex` 文件。检测包含 PATH、`/opt/homebrew/bin/codex`、`/usr/local/bin/codex` 和用户目录中的常用位置。npm 安装的标准软链接会解析到原生程序，避免 Finder 启动时缺少 Node PATH。
3. 默认 Codex 数据目录为 `~/.codex`；应用设置通常在 `~/Library/Application Support/Session Desk`（源码启动可能使用包名目录，以应用的存储地图为准）。不要复制 Windows 的 settings.json，其中有本机路径与系统加密凭据。
4. 先准备 Mac 上的项目文件。此版本只同步项目定义和对话，不传输代码、PDF 等项目文件。
5. 在云端选择项目，将 Windows 的 `D:\Project\paper reading` 映射到 Mac 上真实目录，例如 `/Users/你的用户名/Projects/paper reading`，然后选择目标 Codex 项目。
6. 预览并逐条处理冲突，结束 Codex 中的活动任务后接收。可以勾选自动关闭和重启；macOS 若询问自动化控制权限，请按需允许。权限被拒绝时可自行 Cmd+Q 退出 Codex，再取消勾选自动关闭并重试。

macOS 首版不会强制终止残留进程，桌面端、CLI 或子任务仍运行时停止写入。修复目录索引仍只支持已验证的 `state_5.sqlite` 结构；不兼容时保留备份并停止。

## 制作 Mac 安装包

在 Mac 上运行，Apple Silicon 默认使用 arm64，Intel 默认使用 x64：

```bash
npm ci
npm run dist:mac
```

指定架构：`npm run dist:mac -- arm64` 或 `npm run dist:mac -- x64`。输出位于 `dist/mac/`，包括 DMG 和 ZIP。打包结束后再测试，不同时运行大文件测试。打包不自动上传 GitHub。

当前配置生成未签名、未公证的测试包，macOS 可能阻止直接打开；请只对自己构建且来源可信的应用使用系统提供的“仍要打开”选项，不全局关闭 Gatekeeper。正式分发前应完成 Apple 开发者签名、公证及真机验证。

## 首轮真机验收

- 提供 Mac 芯片类型、macOS 版本、`codex --version` 的结果，不提供账号密码。
- 建立专用测试项目和一条不含隐私的短对话。Windows 发布，Mac 映射不同目录并接收，检查标题、历史、目录及项目归属。
- Mac 继续一条消息并发布，再在 Windows 接收，确认追加而不是重复新建。
- 验证正常退出、权限拒绝和手工退出；两台分别继续同一会话时确认能保留分叉。
- 最后再用较大的测试会话验证。不要第一轮直接接收全部正式项目。

测试失败时提供提示、恢复报告中非敏感的错误字段；不要公开整个会话文件或应用配置。
