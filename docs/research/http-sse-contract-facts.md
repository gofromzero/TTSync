# HTTP 命令冲突与 SSE 重连契约：外部事实研究

> 研究日期：2026-08-09。本文只记录可由规范或第一方文档支持的事实，并将 TTSync 的产品选择单独标注为“产品待决策”。

## 结论摘要

- SSE 的 `EventSource` 会在连接结束后自动重连；浏览器保存最近一次按规范派发的事件 ID，并在重连请求中发送 `Last-Event-ID`。这只是给服务端提供续传游标，规范没有要求服务端保存历史、补发事件、去重或检测间隙。
- SSE 没有内建的可靠消息队列语义。若事件是“失效提示”而不是事实快照，客户端必须能在重复、断线后重连、错过通知的情况下通过权威读取恢复正确状态。
- HTTP 409 表示请求与资源当前状态发生冲突；若请求明确使用 `If-Match` 等条件请求而条件为假，RFC 9110 定义的响应是 412。把 `baseRevision` 放在 JSON 中属于应用契约，HTTP 不会替应用决定 409/412。
- PostgreSQL `NOTIFY` 是提交后的瞬时信号，不是持久事件日志：同一事务中同 channel、同 payload 的通知会折叠；初次 `LISTEN` 有提交竞态；payload 在默认配置下必须短于 8000 字节。
- 因此，`{roomId, revision}` 失效通知只有在客户端把它当作“需要重新读取”的提示、服务端把快照/版本作为权威，并且命令写入以原子版本检查保护时才正确。不能把 SSE 或 `NOTIFY` 本身当成完整变更历史。

## 1. SSE / EventSource 的规范语义

### 1.1 自动重连、状态与响应

WHATWG HTML 标准规定 `EventSource` 初始处于 `CONNECTING`，连接建立后为 `OPEN`；连接关闭后，用户代理将进入重连流程并触发 `error` 事件。重连等待时间初始值由实现定义（大约数秒）；用户代理还可以增加额外等待，例如指数退避或等待网络恢复。[WHATWG §9.2.2–9.2.3](https://html.spec.whatwg.org/multipage/server-sent-events.html#the-eventsource-interface)

有效的 SSE 响应必须是 HTTP 200 且 `Content-Type` 为 `text/event-stream`；否则连接失败，规范流程不会把它当作正常事件流。HTTP 204 可用于告诉客户端停止重连；HTTP 301/307 可用于重定向事件流。[WHATWG SSE introduction and processing model](https://html.spec.whatwg.org/multipage/server-sent-events.html#server-sent-events)

事件流必须使用 UTF-8；事件以空行结束，流在一个未以空行结束的半事件中断开时，该不完整事件会被丢弃。[WHATWG §9.2.5–9.2.6](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream)

### 1.2 `id`、`Last-Event-ID` 与 `retry`

- `id: X` 会更新事件源保存的 last event ID；浏览器在事件断线后重连时，若该值非空，就在请求中发送 `Last-Event-ID: X`。空的 `id` 会清空游标，此后重连不发送该请求头。[WHATWG §9.2.3–9.2.5](https://html.spec.whatwg.org/multipage/server-sent-events.html#last-event-id)
- `Last-Event-ID` 是服务器可选的恢复游标；规范只定义浏览器何时发送它，没有规定服务器必须如何解释、保存多长历史或从哪里补发。[WHATWG §9.2.4](https://html.spec.whatwg.org/multipage/server-sent-events.html#last-event-id)
- `retry: <ASCII digits>` 会把该 EventSource 的重连等待时间设为十进制整数（毫秒）；非纯数字值会被忽略。用户代理仍可额外增加等待时间，因此它不是命令重试确认或交付保证。[WHATWG §9.2.6](https://html.spec.whatwg.org/multipage/server-sent-events.html#interpreting-an-event-stream)
- `event:` 只选择事件类型；`data:` 组成事件数据。客户端对 `id` 的保存发生在事件派发步骤中，事件 ID 不等同于服务端对业务命令的确认号。[WHATWG §9.2.6](https://html.spec.whatwg.org/multipage/server-sent-events.html#interpreting-an-event-stream)

### 1.3 心跳、flush 与代理缓冲

以 `:` 开头的行是注释，不触发事件。WHATWG 的作者建议大约每 15 秒发送一行注释，以防遗留代理因空闲超时断开连接；标准同时警告，不了解时序的中间层 HTTP 分块可能损害可靠性。[WHATWG §9.2.7](https://html.spec.whatwg.org/multipage/server-sent-events.html#authoring-notes)

Go `net/http` 的 `http.Flusher` 用于把处理器已经写入的缓冲数据 flush 到客户端；默认 HTTP/1.x 和 HTTP/2 `ResponseWriter` 支持它，但包装器可能不支持，处理器应运行时检查。即使支持 `Flush`，若客户端经过 HTTP 代理，数据也可能直到响应结束才到达客户端。[Go `net/http` package docs](https://pkg.go.dev/net/http#Flusher)

若部署 Caddy，官方 `reverse_proxy` 文档说明默认会为 wire efficiency 部分缓冲响应；不过 `Content-Type: text/event-stream` 会被识别为 streaming response 并立即 flush。该行为仍不替代端到端验证：其他代理、压缩层、负载均衡器或客户端网络可能有自己的缓冲/超时。[Caddy `reverse_proxy` streaming](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming)

## 2. SSE 是否可靠补发、重复与乱序

WHATWG 规范提供的是“断线后重连 + 上次 ID 作为请求头”的协议钩子，而不是事件存储或确认协议。规范没有要求服务端保留事件历史，也没有定义“从 ID 之后补发”的查询窗口、历史已删除时的响应、重复抑制、客户端 ACK 或跨连接的 exactly-once。因此以下是协议边界，而非 SSE 保证：

1. 服务端没有持久化历史或重连查询逻辑时，客户端可能错过断线期间的事件；`Last-Event-ID` 不会自动修复这个窗口。
2. 服务端若按游标补发，客户端仍应接受重复：断线可能发生在服务端写出与客户端处理/网络确认之间，规范没有提供业务级确认点。
3. 事件流按接收顺序解析和派发，但 SSE 没有跨连接的全局排序协议；重连、多个发布者或不同连接的事件顺序必须由应用层定义。
4. 若业务需要检测漏事件，必须在应用层定义单调版本/序列号和 gap 处理；仅使用 `id` 字段并不会强制客户端检查连续性。

这些结论是对 WHATWG 规定范围的直接边界推导：标准明确了重连和 `Last-Event-ID` 的生成，却没有定义历史存储/补发/去重语义。[WHATWG processing model](https://html.spec.whatwg.org/multipage/server-sent-events.html#processing-model)

## 3. HTTP 命令冲突：409、412 与 `If-Match`

RFC 9110 明确区分两类情况：

| 情况 | 标准事实 | 对命令版本的含义 |
| --- | --- | --- |
| 当前资源状态与请求无法共同成立，客户端可解决后重试 | `409 Conflict` 表示请求不能因目标资源当前状态的冲突而完成；响应应尽量提供足够信息帮助识别冲突。[RFC 9110 §15.5.10](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.10) | 若版本号在 JSON body 中作为应用字段（例如 `baseRevision`），服务端可将不匹配定义为 409，并返回当前 revision/冲突信息。具体 body schema 是产品契约。 |
| 请求头中的前置条件为假 | `412 Precondition Failed` 表示请求头给出的一个或多个条件在服务端求值为假。[RFC 9110 §15.5.13](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.13) | 若用 `If-Match` 携带当前资源的强 ETag，匹配失败时不能执行该方法，应返回 412（RFC 也允许在可确定请求已成功应用时返回 2xx）。 |

`If-Match` 使用强实体标签比较，最常见用途是对 POST/PUT/DELETE 等状态变更防止并发客户端造成 lost update；服务端必须在执行方法前求值，条件为假时不得执行请求方法。[RFC 9110 §13.1.1](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.1)

RFC 还指出，条件请求可应用于状态变更方法以防 lost update，且前置条件的求值顺序以 `If-Match` 等“lost update”条件优先。[RFC 9110 §13.1、§13.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1)

所以“命令版本冲突必须是 409”或“必须是 412”都不是脱离请求形态的标准事实：产品需先决定版本是 body 中的应用条件，还是资源 ETag/`If-Match` 的 HTTP 条件（也可以同时定义，但错误码和优先级须写清楚）。

## 4. PostgreSQL `LISTEN` / `NOTIFY` 的事实边界

- `NOTIFY` 在事务中执行时，只有事务提交后才向监听者发送；事务回滚则不会发送。监听方如果正处于事务中，也要等该事务提交或回滚后客户端才收到通知。因此实时监听连接应尽量保持短事务。[PostgreSQL `NOTIFY`](https://www.postgresql.org/docs/current/sql-notify.html)
- 同一事务中同 channel、同 payload 的多次 `NOTIFY` 会折叠为一条；不同 payload 会分别发送；不同事务的通知不会折叠。通知顺序保证为：同事务按发送顺序，不同事务按事务提交顺序（不包括被折叠的重复项）。[PostgreSQL `NOTIFY`](https://www.postgresql.org/docs/current/sql-notify.html)
- 通知队列保存尚未被所有监听 session 处理的通知；队列满时，调用 `NOTIFY` 的事务可能在提交时失败。一个执行 `LISTEN` 后长期停留在事务中的 session 会阻碍清理，并导致队列告警/压力。[PostgreSQL `NOTIFY` queue notes](https://www.postgresql.org/docs/current/sql-notify.html)
- `LISTEN` 在事务提交时才生效；如果随后回滚，监听注册不变。[PostgreSQL `LISTEN` notes](https://www.postgresql.org/docs/current/sql-listen.html)
- 首次建立监听存在竞态：并发提交的通知中，新监听 session 收到的是在其 `LISTEN` 提交步骤中的某个时刻之后提交的事件；这个时刻稍晚于事务查询可能观察到的数据库状态。官方建议：先执行并提交 `LISTEN`，再在新事务读取初始状态，之后依靠通知发现后续变化；初始读取期间已经看见的更新对应的前几条通知通常可安全忽略。[PostgreSQL `LISTEN` race rule](https://www.postgresql.org/docs/current/sql-listen.html)
- 默认配置下 payload 必须短于 8000 字节；官方建议大数据放表中，通知只发送记录键。[PostgreSQL `NOTIFY` parameters](https://www.postgresql.org/docs/current/sql-notify.html)

由上述规则可得可靠性边界：未处于监听注册状态的客户端没有“补收过去通知”的保证；通知本身也不携带可查询的历史。需要可靠恢复时，应把数据库中的当前状态或变更记录作为权威来源，通知只承担低延迟提示。[PostgreSQL `NOTIFY` description and transaction semantics](https://www.postgresql.org/docs/current/sql-notify.html)

## 5. 对 TTSync `{roomId, revision}` 失效通知的正确性约束

以下不是外部规范强制的产品方案，而是将上述事实应用到 TTSync 后必须满足的约束：

1. **通知是 hint，不是快照或命令结果。** SSE/`NOTIFY` 只发送 `{roomId, revision}`，客户端收到后必须重新读取该房间权威快照；收到重复通知应是安全的，不能把通知次数当作变更次数。
2. **重连必须有全量恢复路径。** 初次连接、SSE 断线重连、`Last-Event-ID` 缺失/无法续传、客户端长期离线、PostgreSQL listener 重启，都必须走“读取当前快照并以服务端 revision 校准”的路径。不能假定事件 ID 能补齐历史。
3. **快照读取必须绕过旧缓存。** SSE 请求应使用 `text/event-stream`；快照 GET 应按产品需要设置合适的缓存控制。RFC 9111 的 `no-cache` 表示不能未经源站验证复用响应，`no-store` 则禁止缓存存储/复用。[RFC 9111 §5.2.2.4–5.2.2.5](https://www.rfc-editor.org/rfc/rfc9111.html#section-5.2.2)
4. **版本必须单调且与写入原子绑定。** 服务端应在同一事务中检查命令的基线版本、写入房间状态并递增 revision，然后在该事务提交后发出失效通知；这样通知不会在回滚状态时先于权威数据可见。PostgreSQL 的 `NOTIFY` 提交时机支持这一顺序，但不会替代数据库事务约束。
5. **命令冲突错误需固定一种明确契约。** 若客户端提交 JSON `baseRevision`，可以定义 409 并返回 `currentRevision`/需要重读的错误细节；若客户端提交资源 ETag 并使用 `If-Match`，应按 412 处理不匹配。两者都可行，但客户端不能靠猜测错误码决定是否重读。
6. **不能依赖 `revision` 本身证明没有丢通知。** 客户端可将收到的 revision 与本地 revision 比较：小于等于本地值可忽略，大于本地值触发快照读取；但若完全没收到通知，仍需在重连/重新进入房间时主动读取。若系统要诊断 gap，可另定义 SSE `id` 与房间 revision 的映射和重连后的快照校准规则。
7. **传输层要有心跳和端到端观测。** 服务端应定期发送 SSE 注释心跳并 flush；反向代理需确认 `text/event-stream` 不被长时间缓冲。心跳只能保持连接/暴露断线，不能提升事件历史可靠性。

## 6. RFC 9457 Problem Details 与状态码关系

RFC 9457（取代 RFC 7807）定义的是 HTTP 响应内容的机器可读错误详情格式，不是新的状态码或业务错误分类。JSON 序列化使用 `application/problem+json`；Problem Details 可以与任何 HTTP 状态码一起使用，但最自然地用于 4xx/5xx。[RFC 9457 §1、§3](https://www.rfc-editor.org/rfc/rfc9457.html#section-3)

### 6.1 标准成员与扩展

Problem Details 对象的标准成员是：

- `type`：标识问题类型的 URI reference；缺省为 `about:blank`。
- `status`：源站生成的 HTTP 状态码数字；如果出现，仅供消费者参考，但生成方必须让它与实际 HTTP 响应状态码一致。
- `title`：问题类型的简短、人类可读摘要，除本地化外不应随 occurrence 改变。
- `detail`：本次 occurrence 的人类可读说明；客户端不应解析它来提取机器信息。
- `instance`：标识本次问题 occurrence 的 URI reference，可不可解引用由服务端决定。

这些成员不是都必填；若成员值类型不符合 RFC 规定，消费者必须忽略该成员。RFC 9457 的非规范性 Appendix A JSON Schema 也不能替代正文约束。[RFC 9457 §3.1、Appendix A](https://www.rfc-editor.org/rfc/rfc9457.html#section-3.1)

问题类型可以定义扩展成员，客户端必须忽略不认识的扩展。RFC 示例中的 `errors` 数组用于表达多个字段校验错误，但它是示例问题类型定义的扩展，不是 RFC 9457 规定的标准成员、字段名、数组元素 schema，也不规定 JSON Pointer 必须用于字段定位。[RFC 9457 §3.2](https://www.rfc-editor.org/rfc/rfc9457.html#section-3.2)

当多个问题彼此不属于同一类型时，RFC 9457 **建议**响应最相关或最紧急的一个；泛化的 batch 问题虽然可自行定义，但与 HTTP 语义结合并不理想。因此“一个响应包含多个字段错误”需要 TTSync 自定义扩展（例如 `errors`/`violations` 的元素字段、指针格式、稳定 code），并不由 RFC 自动给出。[RFC 9457 §3 示例](https://www.rfc-editor.org/rfc/rfc9457.html#section-3)

### 6.2 与 409、412、422、429 的关系

Problem Details 只承载状态码对应的额外细节，不改变状态码本身的语义，也不要求某个状态码必须使用 `application/problem+json`。状态码仍按各自规范解释：

| 状态码 | 状态码的标准语义 | 可携带的 Problem Details 内容（示例，不是 RFC 9457 强制字段） |
| --- | --- | --- |
| 409 | 请求与目标资源当前状态冲突，用户可能解决冲突后重试。[RFC 9110 §15.5.10](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.10) | `type`、`currentRevision`、`conflict` 等产品扩展 |
| 412 | 请求头中的一个或多个前置条件求值为假。[RFC 9110 §15.5.13](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.13) | `type`、当前 ETag/版本的诊断信息（是否暴露由产品决定） |
| 422 | 服务端理解请求媒体类型且语法正确，但无法处理其中的指令。[RFC 9110 §15.5.21](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.5.21) | RFC 9457 的示例使用 422 承载自定义 `errors` 数组；数组 schema 仍是应用定义 |
| 429 | 一段时间内客户端发送过多请求（rate limiting）；响应应说明情况，可带 `Retry-After`。[RFC 6585 §4](https://www.rfc-editor.org/rfc/rfc6585.html#section-4) | `type`、限流维度/剩余时间等产品扩展；`Retry-After` 是 HTTP 响应头，不是 Problem Details 标准成员 |

RFC 9457 允许新问题类型定义其适用的 HTTP 状态码，且可以规定适当场景使用 `Retry-After`；它没有把“版本冲突”“字段校验失败”“限流”强行映射为某一个问题类型或响应 body。[RFC 9457 §4](https://www.rfc-editor.org/rfc/rfc9457.html#section-4)

### 6.3 TTSync 仍需决策

TTSync 可以统一使用 `Content-Type: application/problem+json`，但仍需产品化定义：问题类型 URI（是否稳定、是否可访问文档）、每个状态码允许/要求的扩展成员、`errors` 元素的字段与定位格式、是否要求客户端忽略未知扩展、`status` 与真实 HTTP 状态码不一致时的处理、以及 409/412/422/429 各自触发条件。尤其不能把 RFC 示例中的 `errors` 数组误当成跨 API 通用标准，也不能让客户端解析 `detail` 来驱动程序逻辑。

## 标准事实与产品仍需决策

### 已由标准/官方文档确定

EventSource 会自动重连；`id` 更新客户端游标；重连可带 `Last-Event-ID`；`retry` 只调节等待时间；注释可作心跳且代理/分块可能影响到达时机；SSE 不规定持久历史、补发、ACK、去重或 exactly-once；409 与 412 的 HTTP 语义不同；`If-Match` 失败对应 412 语义；`NOTIFY` 在提交后发送、同事务同 payload 折叠、`LISTEN` 提交生效且首次有竞态、payload 默认短于 8000 字节。

### TTSync 仍需明确

需要在决策票中固定：命令基线版本放 JSON `baseRevision` 还是 HTTP ETag/`If-Match`（以及 409/412 优先级）；SSE `id` 是否采用全局事件序列还是房间 revision；断线重连是否永远先拉全量快照；revision 是否严格单调、是否允许删除/恢复等操作共用同一序列；快照 GET 的缓存策略；通知丢失/监听器重启时的主动校准频率；以及客户端在收到更大 revision 后是合并局部数据还是始终替换为全量快照。

## 来源清单（第一方）

1. [WHATWG HTML Standard — Server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
2. [RFC 9110 — HTTP Semantics](https://www.rfc-editor.org/rfc/rfc9110.html)
3. [RFC 9111 — HTTP Caching](https://www.rfc-editor.org/rfc/rfc9111.html)
4. [PostgreSQL current docs — NOTIFY](https://www.postgresql.org/docs/current/sql-notify.html)
5. [PostgreSQL current docs — LISTEN](https://www.postgresql.org/docs/current/sql-listen.html)
6. [Go standard library — `net/http` `Flusher`](https://pkg.go.dev/net/http#Flusher)
7. [Caddy docs — `reverse_proxy` streaming](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy#streaming)
8. [RFC 9457 — Problem Details for HTTP APIs](https://www.rfc-editor.org/rfc/rfc9457.html)
9. [RFC 6585 — Additional HTTP Status Codes](https://www.rfc-editor.org/rfc/rfc6585.html)
