# Content 内部总线与事件说明

最后更新：2026-04-03

这份文档总结当前 content script 内部的消息总线结构、完整事件列表，以及几条最核心事件链的触发顺序和内在逻辑。

## 适用范围

这份文档描述的是当前 content 侧在完成内部解耦改造之后的现状。

主要对应这些文件：

- `src/content/app/index.ts`
- `src/content/app/commandBus.ts`
- `src/content/app/eventBus.ts`
- `src/content/app/store.ts`
- `src/content/app/types.ts`
- `src/content.ts`
- `src/content/segmentSubmission.ts`
- `src/content/skipScheduler.ts`
- `src/content/skipUIManager.ts`
- `src/content/previewBarManager.ts`
- `src/content/videoListeners.ts`
- `src/content/messageHandler.ts`
- `src/utils/video.ts`

## 1. 当前总线结构

现在 content 内部的“消息总线”分成四层：

| 层级 | 作用 | 主要 API | 典型用途 |
| --- | --- | --- | --- |
| 跨上下文消息 | popup、background、injected script、MAIN world 之间通信 | `chrome.runtime.sendMessage`、`chrome.runtime.onMessage`、`window.postMessage` | popup 请求、background 桥接、MAIN world 数据访问 |
| 命令总线 | 表达意图，执行动作 | `app.commands.register`、`app.commands.execute` | “执行 X”“打开 Y”“开始调度”“提交分段” |
| 事件总线 | 发布事实，让多个模块订阅 | `app.bus.on`、`app.bus.emit` | “分段已更新”“草稿已变化”“需要展示 skip notice” |
| Store 与 UI Registry | 保存状态快照与当前 UI 实例引用 | `app.store`、`app.ui` | 状态快照、UI 引用、selector、兼容桥接 |

### 内部职责划分

| 组件 | 职责 |
| --- | --- |
| `CommandBus` | 一个 command 对应一个 handler，适合表达明确动作 |
| `EventBus` | 一个 event 可以有多个订阅方，适合表达已经发生的事实 |
| `ContentStore` | 保存 content 侧共享状态快照，支持订阅和选择 |
| `ContentUIRegistry` | 保存 preview bar、pill、button、notice 等 UI 实例 |
| `contentState` | 旧状态兼容层，当前仍在使用，但会同步到 store |
| `trace.ts` | 开发环境下打印 command 与 event trace |

## 2. 使用规则

当前代码里默认遵循下面的规则：

| 用这个 | 什么时候用 |
| --- | --- |
| Command | 调用方有明确意图，希望立刻做某件事 |
| Event | 某个稳定的业务事实已经发生，且可能有多个订阅方 |
| Store | 需要持续读取的状态，而不是一次性通知 |
| `chrome.runtime` / `window.postMessage` | 通信需要跨执行上下文 |

示例：

| 适合作为 command | 适合作为 event | 适合作为 store |
| --- | --- | --- |
| `segment/submit` | `segments/loaded` | `sponsorTimes` |
| `skip/startSchedule` | `segments/submittingChanged` | `sponsorTimesSubmitting` |
| `popup/openInfoMenu` | `skip/noticeRequested` | `channelWhitelisted` |
| `ui/updatePlayerButtons` | `skip/buttonStateChanged` | `selectedSegment` |

## 3. 跨上下文消息边界

内部总线不会替代跨上下文消息，这些边界仍然保留，而且应该继续保留：

| 方向 | 载体 | 作用 |
| --- | --- | --- |
| popup/background -> content | `chrome.runtime.onMessage`，入口在 `src/content/messageHandler.ts` | 把外部协议翻译成内部 command |
| content -> popup/background | `chrome.runtime.sendMessage` | 推送 `videoChanged`、`infoUpdated`、`time` |
| MAIN world -> content | `window.postMessage` 和 injected helper | 页面 ready 信号、channel ID 查询、media session reset |

核心原则是：外部协议只停留在边界适配器，content 内部仍然优先使用 command、event、store、UI registry。

## 4. 当前事件列表

状态说明：

- `active`：当前已经 `emit`，并且至少有一个内部订阅方
- `emit-only`：当前已经 `emit`，但还没有内部订阅方

| 事件 | 语义 | 主要 payload | 主要发射方 | 主要订阅方 | 状态 |
| --- | --- | --- | --- | --- | --- |
| `app/pageReady` | 页面已经真正可供 content 逻辑工作 | `pageLoaded` | `src/content/state.ts` | 暂无 | emit-only |
| `video/resetRequested` | 视频上下文即将切换，content 侧需要先做重置 | `reason` | `src/utils/video.ts` | `src/content.ts` | active |
| `video/idChanged` | 当前 canonical `videoID` 已变化，或需要同 ID refresh | `videoID` | `src/utils/video.ts` | `src/content.ts` | active |
| `video/elementChanged` | 实际绑定的 `HTMLVideoElement` 已变化 | `newVideo`、`video` | `src/utils/video.ts` | `src/content.ts` | active |
| `video/channelResolved` | uploader/channel ID 解析结束 | `channelIDInfo` | `src/utils/video.ts` | `src/content.ts` | active |
| `config/changed` | 本地配置同步监听发现一批配置变化 | `changes` | `src/content/messageHandler.ts` | 暂无 | emit-only |
| `segments/loaded` | 当前视频的正式分段快照已更新完成 | `sponsorTimes`、`status`、`videoID` | `src/content/segmentSubmission.ts` | `src/content/previewBarManager.ts`、`src/content/skipScheduler.ts`、`src/content/segmentSubmission.ts` | active |
| `segments/submittingChanged` | 当前视频的本地草稿分段集合已变化 | `sponsorTimesSubmitting`、`getFromConfig`、`videoID` | `src/content/segmentSubmission.ts` | `src/content/previewBarManager.ts`、`src/content/skipScheduler.ts`、`src/content/segmentSubmission.ts` | active |
| `skip/executed` | 一次 skip 或 mute 效果已经实际执行 | `skipTime`、`skippingSegments`、`autoSkip`、`openNotice`、`unskipTime` | `src/content/skipScheduler.ts` | 暂无 | emit-only |
| `skip/noticeRequested` | skip UI 现在应该展示 notice 或 advance notice | `noticeKind`、`skippingSegments`、`autoSkip`、`unskipTime`、`startReskip` | `src/content/skipScheduler.ts` | `src/content/skipUIManager.ts` | active |
| `skip/buttonStateChanged` | skip button 现在应该启用或禁用，并绑定某个 segment | `enabled`、`segment`、`duration` | `src/content/skipScheduler.ts`、`src/content/messageHandler.ts` | `src/content/skipUIManager.ts` | active |
| `player/timeUpdated` | 当前播放位置投影已更新 | `time` | `src/content/previewBarManager.ts` | 暂无 | emit-only |
| `player/videoReady` | 播放器已经 ready 到可以挂载 UI | `video` | `src/content/videoListeners.ts` | `src/content/previewBarManager.ts` | active |
| `player/durationChanged` | 视频时长变化，通常发生在加载、切清晰度或播放器内部重置后 | `video` | `src/content/videoListeners.ts` | `src/content/previewBarManager.ts` | active |
| `player/play` | 原始 `play` 事件 | `video` | `src/content/videoListeners.ts` | 暂无 | emit-only |
| `player/playing` | 原始 `playing` 事件 | `video` | `src/content/videoListeners.ts` | 暂无 | emit-only |
| `player/seeking` | 原始 `seeking` 事件 | `video` | `src/content/videoListeners.ts` | 暂无 | emit-only |
| `player/pause` | 原始 `pause` 事件 | `video` | `src/content/videoListeners.ts` | 暂无 | emit-only |
| `player/waiting` | 原始 buffering / waiting 事件 | `video` | `src/content/videoListeners.ts` | 暂无 | emit-only |
| `player/rateChanged` | 播放速度变化 | `video`、`playbackRate` | `src/content/videoListeners.ts` | 暂无 | emit-only |
| `ui/popupClosed` | 内嵌 popup iframe 已关闭 | 无 | `src/content/segmentSubmission.ts` | 暂无 | emit-only |

## 5. Command 命名空间概览

虽然现在事件总线已经承担了更多解耦职责，但 command bus 仍然非常重要，因为很多模块之间仍然通过“动作”来协作。

| 命名空间 | 作用 |
| --- | --- |
| `segment/*` | 分段创建、预览、提交、投票、submission notice 控制 |
| `segments/*` | 拉取或导入分段快照、更新草稿快照、选中 segment |
| `skip/*` | 调度、skip 执行、预览时间、virtual time、seek 辅助 |
| `ui/*` | 预览条、播放器按钮、pill、active segment 投影 |
| `popup/*` | 打开和关闭内嵌 popup iframe |
| `port/*` | port-video 的提交、投票、刷新 |
| `config/*` | 受配置驱动的 UI 副作用，例如分类颜色 |

当前约定是：

- “立刻做某件事”优先使用 command。
- “某个业务事实已经成立”优先使用 event。

## 6. 核心事件链

下面整理几条现在最重要的事件链，按触发顺序描述。

### 6.1 视频切换生命周期

这是 content 侧最重要的启动链。

#### 触发顺序

1. `src/utils/video.ts` 通过 `checkVideoIDChange()` 或 `videoIDChange(id)` 检测到视频 ID 变化。
2. `src/utils/video.ts` 先调用自己的 `resetValues()`，并发出 `video/resetRequested`。
3. `src/content.ts` 订阅 `video/resetRequested`，执行 content 侧 `resetValues()`。
4. content 侧 reset 会清空 scheduler、submission、preview bar、notice、active keybind、selected UI 状态等。
5. `src/utils/video.ts` 更新新的 `videoID`，开始白名单检查，并发出 `video/idChanged`。
6. `src/content.ts` 订阅 `video/idChanged`，执行 `videoIDChange()`。
7. `videoIDChange()` 会发送外部 `videoChanged` 消息、执行 `segments/lookup`、清空并恢复草稿、刷新 player 相关 UI。
8. 当实际 DOM 里的 video 元素变化时，`src/utils/video.ts` 发出 `video/elementChanged`。
9. `src/content.ts` 订阅 `video/elementChanged`，安装 video listener、skip button bar、pill，以及 preview bar 检查逻辑。
10. 当 uploader 解析结束时，`src/utils/video.ts` 发出 `video/channelResolved`。
11. `src/content.ts` 订阅 `video/channelResolved`，更新基于白名单的 skip 行为。

#### 内在逻辑

- `src/utils/video.ts` 负责浏览器和页面层面的检测。
- `src/content.ts` 负责 content 生命周期 fan-out。
- `video/resetRequested` 是“浏览器视频检测”和“content 侧清理”之间的分界点。
- `video/idChanged` 的语义是“现在应该开始加载新视频上下文”，而不是“所有相关数据已经准备完”。

#### 注意点

对于 `Festival` 和 `Anime` 页面，`src/utils/video.ts` 可能在 `videoID` 值没有变化的情况下也发出 `video/idChanged`，因为页面仍然需要 refresh 路径。下游订阅方不要把它完全等同于“值真的变了”。

### 6.2 `segments/loaded`

这是当前最核心的分段领域事件。

#### 主要上游来源

- `src/content/segmentSubmission.ts` 中的 `sponsorsLookup()`
- `src/content/segmentSubmission.ts` 中 `sendSubmitMessage()` 的成功路径

#### 触发顺序

1. 拉取分段或提交成功后，更新 `contentState.sponsorTimes` 和 `contentState.lastResponseStatus`。
2. `emitSegmentsLoaded()` 先把最新快照同步进 `app.store`。
3. `emitSegmentsLoaded()` 再发出 `segments/loaded`，并带上 `videoID`。
4. `src/content/previewBarManager.ts` 订阅后，如果事件属于当前视频，就刷新 preview bar。
5. `src/content/skipScheduler.ts` 订阅后，如果事件属于当前视频且分段列表非空，就调用 `startSkipScheduleCheckingForStartSponsors()`。
6. `src/content/segmentSubmission.ts` 自己也作为 bridge 订阅方，向 popup/background 发送 `infoUpdated`。
7. VIP 模式下，同一个 bridge 还会顺带刷新 locked categories。

#### 内在逻辑

- 发射方只负责发布最终的分段快照。
- preview bar 刷新、popup 同步、skip 重算不再硬编码在 `sponsorsLookup()` 内部。
- payload 带 `videoID`，就是为了避免异步请求晚到后污染新视频。

### 6.3 `segments/submittingChanged`

这是当前本地草稿分段的主事件。

#### 主要上游来源

- `updateSponsorTimesSubmitting()`
- `clearSponsorTimes()`
- `sendSubmitMessage()` 的成功路径

`startOrEndTimingNewSegment()`、`cancelCreatingSegment()`、`importSegments()` 这些路径，最终也都会通过 `updateSponsorTimesSubmitting(false)` 或共享的 emit helper 进入这条链。

#### 触发顺序

1. 草稿分段被创建、结束、取消、导入、从 config 恢复、被清空，或者在成功提交后变成空列表。
2. 最新草稿列表写入 `contentState.sponsorTimesSubmitting`。
3. `emitSubmittingChanged()` 先把最新草稿快照同步进 `app.store`。
4. `emitSubmittingChanged()` 再发出 `segments/submittingChanged`，并携带 `getFromConfig` 和 `videoID`。
5. `src/content/previewBarManager.ts` 订阅并刷新当前视频的 preview bar。
6. `src/content/skipScheduler.ts` 订阅并在有 video 元素的情况下重算当前视频的 schedule。
7. `src/content/segmentSubmission.ts` 自己也作为 UI bridge 订阅，刷新 player buttons 和当前打开的 submission notice。

#### 内在逻辑

- 草稿变化现在被视为一个业务事实，而不是一串直接 UI 调用。
- 发射方不再需要知道哪些 UI 组件应该刷新。
- `getFromConfig` 保留了这次变化的来源，方便后续订阅方按来源分支。

#### 顺序说明

`startOrEndTimingNewSegment()` 目前会先调用 `sponsorsLookup(true, true)`，再调用 `updateSponsorTimesSubmitting(false)`。

所以实际运行时经常是：

1. 本地草稿先变化
2. 分段查询开始
3. `segments/submittingChanged` 先发出
4. 查询完成后，`segments/loaded` 再发出

这符合当前模型，因为“草稿变化”和“正式服务器快照变化”本来就是两个不同的事实。

### 6.4 `skip/noticeRequested` 与 `skip/buttonStateChanged`

这两个事件现在是 skip UI 解耦的核心边界。

#### 主要上游来源

- `src/content/skipScheduler.ts`

#### advance notice 触发顺序

1. `startSponsorSchedule()` 计算出下一个 skip 窗口。
2. 如果需要提前展示 advance notice，scheduler 会创建一个定时器。
3. 定时器触发后，scheduler 发出 `skip/noticeRequested`，并携带 `noticeKind: "advance"`。
4. `src/content/skipUIManager.ts` 订阅后创建 `advanceSkipNotice`。

#### 普通 skip notice 触发顺序

1. `skipToTime()` 判断这次是 auto skip、manual skip 还是 submit-preview skip。
2. 如果应该展示普通 notice，scheduler 发出 `skip/noticeRequested`，并携带 `noticeKind: "skip"`。
3. `src/content/skipUIManager.ts` 订阅后创建 `SkipNotice`。

#### skip button 控制链路

1. `skipToTime()` 判断出这是 POI 或手动按钮路径。
2. scheduler 发出 `skip/buttonStateChanged`，其中 `enabled: true`，并带上对应的 `segment`。
3. `src/content/skipUIManager.ts` 订阅后启用 `SkipButtonControlBar`。
4. UI manager 同时更新 `contentState.activeSkipKeybindElement`，让热键逻辑能指向正确目标。

#### disable 路径

1. `src/content/messageHandler.ts` 中某个 segment 可能被 hide。
2. 如果当前 skip button 不该再可用，message handler 会发出 `skip/buttonStateChanged`，其中 `enabled: false`。
3. `src/content/skipUIManager.ts` 订阅后禁用 control bar，并在需要时清理 active keybind target。

#### 内在逻辑

- `skipScheduler` 现在负责“决策”。
- `skipUIManager` 现在负责“渲染和创建 UI 对象”。
- scheduler 不再直接 new `SkipNotice`、`advanceSkipNotice`，也不再直接操纵 skip button DOM 对象。

#### 相关事件

`skip/executed` 会在实际 skip 或 mute 效果已经执行之后发出，但当前还没有订阅方。

它现在已经是一个稳定扩展点，后续很适合接：

- popup 同步
- telemetry / analytics
- skip 之后的 UI 投影

### 6.5 `player/videoReady`、`player/durationChanged` 与 `player/timeUpdated`

这组事件属于播放器适配层。

#### 触发顺序

1. `src/content/videoListeners.ts` 在 `loadstart` 时发出 `player/videoReady`。
2. `src/content/previewBarManager.ts` 订阅后，如果需要就创建 preview bar，然后刷新。
3. `src/content/videoListeners.ts` 在 duration 变化时发出 `player/durationChanged`。
4. `src/content/previewBarManager.ts` 订阅后刷新 preview bar。
5. `src/content/previewBarManager.ts` 在更新 active segment 投影时发出 `player/timeUpdated`。
6. 同一个函数还会向 popup/background 发送外部 `time` 消息。

#### 内在逻辑

- `videoListeners.ts` 充当播放器适配器。
- `previewBarManager.ts` 充当 UI 投影订阅方。
- 高频事件 `player/timeUpdated` 应该保持轻量，不适合挂重逻辑。

## 7. 当前事件拓扑总结

现在已经比较成熟的事件驱动链主要有这几条：

| 链路 | 当前结果 |
| --- | --- |
| `video/*` lifecycle | 浏览器页面检测和 content 清理/重启已经分离 |
| `segments/loaded` | 一次分段快照更新现在会自动 fan-out 到 preview bar、scheduler、popup sync |
| `segments/submittingChanged` | 一次草稿快照变化现在会自动 fan-out 到 preview bar、scheduler、buttons、submission notice |
| `skip/noticeRequested` 与 `skip/buttonStateChanged` | scheduler 决策和 skip UI 创建已经分离 |

下面这些事件现在已经存在，但更多还是扩展点：

| 事件 | 下一步典型订阅方 |
| --- | --- |
| `app/pageReady` | thumbnail setup、延迟页面 UI 安装、dynamic/comment blocker 启动 |
| `config/changed` | store projection、基于配置的 UI 重算 hook |
| `skip/executed` | popup 同步、telemetry、post-skip UI |
| `player/timeUpdated` | 轻量级 live indicator |
| `player/play`、`player/playing`、`player/seeking`、`player/pause`、`player/waiting`、`player/rateChanged` | 如果以后把 scheduler 从 command 驱动迁到 event 驱动，可以从这里开始接 |
| `ui/popupClosed` | popup 状态清理、统计 hook |

## 8. 维护建议

以后继续扩展时，优先按下面这套思路判断：

1. 如果调用方是“想立刻做一件事”，优先加 command 或复用 command。
2. 如果多个模块都应该在某个稳定业务事实成立后响应，优先加 event 或复用 event。
3. 如果这个值需要长期可读，放到 store 或镜像状态里。
4. 如果通信要跨 popup、background、MAIN world，就继续用浏览器消息 API 放在边界层。

继续扩展事件集合时，建议优先做这类业务事件：

1. `segment/visibilityChanged`
2. `channel/whitelistChanged`
3. `port/videoUpdated`

同时要注意：

1. 不要把重逻辑挂到 `player/timeUpdated` 上。
2. 异步结果类事件最好带上 `videoID` 或其他 freshness 标记。
3. UI 创建逻辑尽量放在 UI 订阅方里，不要重新回流到 scheduler 或数据拉取模块里。
