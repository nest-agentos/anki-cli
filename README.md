# anki-cli

NestOS 工具包使用指南见 [`guide.yaml`](guide.yaml)，工具箱会在注册前后持续提供该指南。`toolbox.yaml` 声明系统预装与普通参数设置，每个用户默认停用并独立启用。

独立 Rust 制卡工具，将 `anki-helper` 的单词/背诵字段、51 字段模板、稳定笔记标识、媒体打包、Markdown 导出和旧项目读取迁入可复用 CLI。模型连接与文本、图片、语音生成由 NestOS Flow 负责；本工具处理确定性的输入解析、字段合并、媒体映射、YAML 清单和 `.apkg`。不包含原来的 Web 服务、模型配置页或厂商 SDK。

## 构建与验证

```bash
cargo build --release --locked
cargo test --locked
cargo build --locked
node --test tests/node.mjs
```

构建产物为 `target/release/anki-cli`（Windows 为 `anki-cli.exe`）。默认模板随二进制嵌入，SQLite 与 bzip2 使用静态构建。Node 扩展仅依赖 Node 内置模块，宿主提供 Tool/Zod 工厂。

## YAML 打包契约

Flow 最终输出 **`anki.manifest.yaml` + `media/` + `deck.apkg`**。清单是打包输入，不是模型生成的执行脚本；Rust 校验版本、身份、文件名、路径和媒体摘要。参考 [最小清单](examples/anki.manifest.yaml)：

```yaml
version: 1
deck:
  id: 123456789
  name: 英语单词
output: deck.apkg
cards:
  - id: apple.json
    kind: word
    data:
      name: apple
      chn: 苹果
      audio: apple.mp3
media:
  - name: apple.mp3
    path: media/apple.mp3
    sha256: 可选的文件SHA256
```

`kind` 为 `word` 或 `recite`，`data` 使用原 WordData / ReciteData 字段。牌组 `id` 与卡片 `id` 构成稳定身份，修改内容后重复导出保留 GUID。媒体引用必须对应 `media.name`，输入路径与输出路径均相对清单目录，拒绝越界路径和符号链接逃逸。可选 `template` 指向同目录树内的自定义 51 字段 JSON 模板。所有媒体先核验，再流式写入临时 ZIP，完成后替换最终包；缺文件或校验失败保留旧包。

```bash
anki-cli validate examples/anki.manifest.yaml
anki-cli pack examples/anki.manifest.yaml
```

## 原项目迁移与导出

```bash
anki-cli init ./project --input words.txt
anki-cli merge ./project --input completed-cards.json
anki-cli merge ./project --input regenerated-cards.json --replace
anki-cli migrate ./project
anki-cli pack ./project
anki-cli pack ./project/anki.manifest.yaml
anki-cli md ./project --output cards.md
anki-cli pkg2md ./deck.apkg --output ./unpacked
```

`init` 接受逐行单词、`Unit N` 分组和 WordData JSON（兼容旧数字 Unit 标记），已有同名单词保持原样；文件名冲突拒绝写入。`merge` 只补缺失文本、保留手工修改、身份和扩展字段；`--replace` 显式替换文本，例句或配图描述改变时使对应媒体引用失效。`migrate` 读取 `word_json/`、`recite_json/`、`audio/`、`images/` 和 `.anki-deck-id`，生成清单；`pack <项目目录>` 兼容直接导出，首次成功后保存牌组 ID。原项目必须带齐引用的媒体，不再静默漏掉缺失文件。

`pkg2md` 面向本项目的 51 字段模板，读取 `collection.anki2` / `collection.anki21` / Zstd 压缩的 `collection.anki21b`，输出卡片 JSON、Markdown、可重新打包的清单及媒体。媒体索引使用传统 JSON 映射；不声明支持任意 Anki 模型或新版 protobuf 媒体索引。

## 接入 NestOS

宿主配置采用通用外部 Tool 模块加载，不需要将 Anki 实现加入平台内置工具：

本仓库提供 `nestos-tool.json` 工具包清单，声明包版本、六个工具的版本、Node 扩展和可执行程序位置。NestOS 的 Node 宿主默认从启动仓库的 `tools/` 发现这些清单；也可通过 `NESTOS_TOOL_PACKAGE_DIRS` 指定绝对目录的 JSON 数组。Flow 安装、导入和系统恢复通过同一依赖准备服务注册工具，工具箱「工具包与依赖」可检查和重试，无需为 Anki 增加平台特例。

源码保留在本子仓库。安装的运行包默认位于 `${XDG_DATA_HOME:-~/.local/share}/nestos/tools/anki-cli/0.1.0/`，注册元数据位于 `${XDG_CONFIG_HOME:-~/.config}/nestos/tool-packages.json`。程序查找顺序为 `ANKI_CLI_BIN`、PATH 中的 `anki-cli`、本包的 `target/release/anki-cli`；因此已复制到 `/usr/local/bin/anki-cli` 的程序可以直接复用。配置目录不存放二进制，安装不自动下载未知工具或执行编译。

已有部署也可继续显式配置扩展：

```bash
export ANKI_CLI_BIN=/absolute/path/anki-cli
export NESTOS_TOOL_MODULES='["/absolute/path/anki-cli/node/extension.mjs"]'
```

在这两个环境变量下启动 Node 宿主（httpd 或 CLI）。扩展注册 `anki.prepare@1`、`anki.recognize@1`、`anki.batch@1`、`anki.collect@1`、`anki.plan@1`、`anki.package@1`；浏览器和 Tauri 未安装此 Node 扩展时不具备 Rust 打包能力。

本包提供确定性的 Anki Tool 与 Rust 打包能力；Flow 是平台通用定义，不属于 Tool 包。NestOS 应用层保留唯一可恢复资源 [anki-generate.json](../../backend/app-core/src/resources/flows/anki-generate.json)，恢复为一个 `anki-generate.flow`。该资源提供文本、JSON、图片及多组输入的统一入口，并通过通用 `functions` 声明内部制卡、单组识图、单批补全函数；这些函数不会单独出现在工具箱中。Tool 包不再保存 Flow 副本，独立 Cargo 构建和测试不依赖 NestOS 应用源码。

在 NestOS 系统设置中显式恢复这一个流程资源，或导入从恢复目录导出的同一定义；无需分别导入或发布内部函数。恢复使用应用层通用资源机制，已安装旧版 `anki-generate` 不会被自动覆盖；已有用户文件和冻结运行不自动改写。可由用户自行组织到工具箱抽屉。在入口表单绑定 `text`，按需绑定 `image` / `speech`；配图和语音默认关闭。图片入口还需绑定支持图片输入的 `vision` 聊天连接。最多 12 张 PNG/JPEG/WebP 原图、合计 80 MiB，宿主单图上传上限 20 MiB；image.process@1 按 Flow 配方缩放至最长边 2048、转灰度、编码 JPEG，处理后单图最多 2 MiB、合计 6 MiB。原图和派生图以资产引用持久保存，处理节点可预览，恢复时无需重新选择。识别后始终暂停供用户修改 JSON，校对提交前不会开始补全或打包。

统一入口通过 `builtin.flow@2` 将参数、连接槽传入内部制卡函数，入口限制整次运行的并发和节点数。图片识别和文本补全使用通用 `parameterSets` 多组函数实参调用单组识图和单批补全函数，`maxConcurrency: 4` 有界并发，返回值按参数组顺序汇合。业务工具仅校验输入并产生实参集合，不生成这些任务的节点图；提示词、卡片字段和业务完整性检查留在本外部包。内部制卡函数使用 `builtin.spawn` 的 `scope: local` 隔离动态媒体/打包节点；YAML 契约和 Rust 打包无需区分单词来自文本还是图片。

统一入口参数：

- `words`：逐行单词、Unit N 分组或 WordData JSON；也可以只提供 `images`。
- `wordsGroups`：文本组数组，例如 `["Unit 1\napple", "Unit 2\npear"]`，可与 `words`、图片同时提供。
- `processingMode`：`combined` 合并输入后处理，`grouped` 按组分别处理；最终都生成一个完整包。图片校对显示可编辑的各组卡片数量；增删卡片需同步调整数量，分组边界会保留到文本补全阶段。
- `imageGroups`：图片分组索引，例如 `[[0,1],[2]]`。分组模式留空时每张图片一组；每张图片必须恰好属于一组。
- `groupUnits`：各图片组页首的延续单元，例如 `[1,3,5]`；图片中明确的 Unit 标题优先。

模型使用 `json_object`、完整输出字段说明、流式响应与关闭 thinking，不要求服务商支持 `json_schema`。本地 `outputValidation.schema` 对非法 JSON、缺字段和类型错误进行有限修复；漏卡、身份变化和业务规则由工具明确拒绝。请按原图核对模型转录，工具只能验证已识别数据的内部一致性，不能证明模型没有漏读图片。

CLI 只读取这一个 `.flow`，内部函数按词法作用域解析，不需要兄弟定义文件或外部流程目录。图片参数为 `images: [{"type":"image_url","image_url":{"url":"data:image/png;base64,..."}}]`（标准消息内容块），CLI 会在持久化之前暂存为资产引用；CLI 等待校对时返回 3，通过 `respond <run-id> <request-id> --value '{"cards":[...]}'` 提交，再 `resume <run-id>`。运行快照已保存完整内部函数及编译图，恢复不重新读取最新定义。

音频与图片由 Flow 经平台连接生成，模型目录、厂商端点、协议适配和凭据均由 itookit 管理。工具仅传递调用方选择的音色，不设置厂商音色默认值；打包接收已生成媒体，不读取 Provider 或 Connection 配置。

流程为：输入 → Rust 预校验 → 模型补全 → Rust 确定性合并与规划 → 每卡片媒体节点 → Rust 清单与打包。预校验在模型请求前检查工具环境、身份和总量1000张上限。通用 `builtin.transform` 的 `batch` 操作按 Flow 定义中的每次最多20张生成参数集合，保留 `combined` / `grouped` 边界，通用 Flow 函数调用执行补全；旧 `anki.batch` 仅为已冻结运行保留兼容；`anki.collect` 校验所有任务的数量、身份、字段和顺序，最后合并为一个完整包，不丢弃超过20张的内容。媒体作为持久 Task 资产返回，仅允许同一个 Flow 内的打包工具读取；输出采用工作区的原有写权限。每次打包保存到 `输出目录/<操作摘要>/`，保留之前的产物。打包回执核对包、清单和媒体摘要；缺少或损坏回执保留不确定状态，不自动重放写操作。工作区导出目前限制单包 128 MiB；独立 Rust CLI 没有该内存导出限制。

普通应用资源恢复测试只消费应用 JSON，不要求本外部包的 Rust 二进制。在 NestOS 主仓库可显式运行本包与恢复资源之间的 Flow 集成测试及完整模拟端点验收：

```bash
cargo build --manifest-path tools/anki-cli/Cargo.toml --locked
pnpm --filter @nestos/cli exec vitest run --config ../../tools/anki-cli/tests/nestos-vitest.config.mjs
node tools/anki-cli/tests/verify-flow.mjs
```

该脚本从唯一应用恢复 JSON 导出一个 `.flow` 到临时孤立目录，再验收统一入口的文本/图片、合并/分组处理并实际生成 `.apkg`，检查图片识别后的暂停、跨进程校对/恢复、校正内容与媒体，以及恢复时不重复请求。脚本使用模拟端点，不调用真实付费服务，也不自动打开 Anki 桌面应用。

2026-10-22 在 NestOS 主仓库另以真实模型、函数批调用迁移前的冻结定义验证五张图片：312 条笔记、624 张复习卡，按原图五组拆为 18 个补全批次，ZIP/SQLite、完整字段、跨单元同名、解包重打包以及恢复不重复执行全部通过。记录位于主仓库 `doc/design/fixtures/anki-yimg-cli-evidence.json`。该次未生成配图/语音，未做 Anki 桌面导入。动态打包任务使用 180 秒限时；失败仍保留业务核对语义，不无限延长或自动重放未知结果。

图片格式、数量和总字节限制由入口及内部识图函数的 imageConstraints 声明；本流程选择 PNG/JPEG/WebP、12 张、原图合计 80 MiB；模型发送预算独立限制处理后合计 6 MiB。缩放、颜色和编码由版本化 recipe 声明，通用 image.process Tool 由宿主安装，Anki CLI 不实现图片处理。视觉 Agent 使用 messageTemplates 声明标准多模态消息，与已有字面消息快照分开处理。
