# 连接可以恢复，结果不明的写操作不自动重放

状态：implemented

`tools/call` 发出后断线，客户端没收到回复，不等于服务端没做。旧策略只看调用是否抛错：创建任务已经成功、只有回复丢失时，自动重试会创建第二份。

默认只在本机确认请求尚未交给客户端，或工具明确声明只读、幂等时允许重试。其余调用在结果不明时立即报错，提醒先查看服务端状态；需要重连时留给下一次新调用，别让连接恢复顺手再执行一次旧参数。取消和 `retry: "none"` 仍然优先。

不为这个问题增加配置项：重试是否安全取决于这一次工具调用，不是整台 MCP 服务器。

模型原先看到最后一次失败的错误；现在，结果未知且不可重复的调用返回 `MCP tool may have already executed. Result unknown; not retried. Check before repeating.`（88 字节）。重连后工具不再声明可重放时，返回 `MCP tool no longer declares replay safety; call was not retried.`（64 字节）。两条均为固定文本，不拼接远端数据。工具声明与固定前缀增加 0 token；缓存变化从这次失败的工具结果开始，不使此前的前缀失效。
