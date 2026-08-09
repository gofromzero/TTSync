# 头像上传与本地文件生命周期：外部事实研究

> 研究日期：2026-08-09。本文只引用 OWASP、Go、WHATWG/IETF/IANA/W3C 和 PostgreSQL 的官方资料。下文把“外部事实”和“Wayfinder 产品待决策”明确分开；带有“推荐模式”的内容是根据这些事实作出的工程推导，并非某项标准对 TTSync 的强制要求。

## 结论摘要

1. 扩展名、客户端声明的 MIME、文件头/魔数都只能提供部分信号，不能单独证明文件是安全图片。稳妥的头像流水线应组合：请求字节上限、格式白名单、MIME/魔数一致性检查、`image.DecodeConfig` 尺寸检查、完整真实解码、再编码为受控输出格式，并且只保存再编码后的字节。
2. `image/gif.Decode` 只返回第一帧；PNG 也可能是向后兼容的动画 PNG（APNG）。SVG 则具有脚本和事件处理能力。若头像定义为“静态栅格图”，仅允许 `.png`/`.jpg` 后缀仍不够，必须通过再编码消除动画和原始元数据，或另外识别并拒绝动画容器；SVG 应排除在普通栅格上传通道之外。
3. 原始文件名不应成为存储路径。使用服务端生成、不可变且不透明的文件 ID，把文件放在 webroot 外，只经应用处理器读取；响应显式发送已记录的规范 `Content-Type`，并附 `X-Content-Type-Options: nosniff`。`nosniff` 是响应侧纵深防御，不是上传校验器。
4. PostgreSQL 事务和本地文件系统操作不共享一个原子提交边界。可靠的失败方向是“先完成不可变文件，再提交数据库引用”：数据库失败只留下可回收孤儿，而不会产生指向未完成文件的新引用。替换头像时创建新文件 ID、原子切换数据库指针，旧文件交给延迟的可达性回收。
5. 备份必须把数据库快照和文件集合视为同一代制品。最直接的方案是暂停写入和 GC 后一起备份；在线方案则必须维持“文件先于引用完成、对象不可覆盖”，先取得数据库逻辑快照，再复制全部不可变文件，并在复制结束前冻结删除/GC。恢复后应校验每个数据库引用的文件及摘要。

## 1. 上传格式与内容真实性

### 外部事实

- OWASP 要求只允许业务需要的扩展名；在解码文件名后再做扩展名校验，并警告双扩展名、空字节等绕过方式。客户端上传的 `Content-Type` 很容易伪造，只能作为快速检查；文件签名/魔数也不应单独使用，必须与其他验证组合。[OWASP File Upload Cheat Sheet：Extension Validation、Content-Type Validation、File Signature Validation](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html#extension-validation)
- WHATWG 说明 HTTP 提供的 MIME 类型可能缺失或错误，文件扩展名也不可靠且容易伪造；其 MIME Sniffing 标准列出的 GIF、WebP、PNG、JPEG 字节模式用于类型识别，不等于对完整文件的安全验证。[WHATWG MIME Sniffing](https://mimesniff.spec.whatwg.org/)
- Go 的 `http.DetectContentType` 实现 WHATWG 嗅探算法，只检查最多前 512 字节，无法证明后续内容能被图片解码器完整解析。[Go `net/http.DetectContentType`](https://pkg.go.dev/net/http#DetectContentType)
- Go `image.Decode` 会识别已注册的图片格式并调用相应解码器；`image.DecodeConfig` 可在不解码整张图片的情况下取得色彩模型和尺寸。要支持 GIF/JPEG/PNG，程序需要注册相应解码包。[Go `image` 包](https://pkg.go.dev/image)；[Go `image/format.go` 源码](https://go.dev/src/image/format.go)
- Go `http.MaxBytesReader` 能限制传入请求体的读取量，并在超限时返回错误，用来保护服务器资源。[Go `net/http.MaxBytesReader`](https://pkg.go.dev/net/http#MaxBytesReader)
- IANA 的官方媒体类型注册表包含 `image/gif`、`image/jpeg`、`image/png`、`image/apng` 和 `image/svg+xml`；媒体类型名称应取自规范注册，而不是从用户文件名自由拼接。[IANA Media Types Registry](https://www.iana.org/assignments/media-types/media-types.xhtml)

因此，扩展名、客户端 MIME、前 512 字节嗅探和完整解码分别回答不同问题；任意单项都不是“真实图片且适合作头像”的充分条件。

### 推荐校验流水线（工程推导）

1. 在 multipart 解析和解码前，用 `MaxBytesReader` 限制整个请求；同时限制单文件字节数。不能只信 `Content-Length`，因为请求可能没有该字段或实际读取超限。
2. 原始文件名仅用于审计或友好错误提示；先做规范化，再用精确白名单检查扩展名。原始文件名绝不进入最终路径。
3. 检查客户端 MIME、`DetectContentType`/魔数与允许格式是否一致；未知类型或相互冲突时拒绝。该步骤只做早期拒绝，不代替解码。
4. 调用 `image.DecodeConfig`，校验返回格式、宽、高、长宽比和像素总量；计算 `width * height` 时使用不会溢出的比较方式。
5. 调用 `image.Decode` 做真实完整解码，再核对返回格式及最终边界。解码错误即拒绝。
6. 对像素做必要的方向处理、裁剪和缩放，然后用受控的 `jpeg.Encode` 或 `png.Encode` 再编码；只保存新输出，不保存用户原始字节。这样存储对象来自解码后的 `image.Image` 像素，而不是原文件中的附加块、尾随内容或多帧容器。[Go `image.Image`](https://pkg.go.dev/image#Image)；[Go `image/jpeg`](https://pkg.go.dev/image/jpeg)；[Go `image/png`](https://pkg.go.dev/image/png)
7. 对最终字节计算摘要，记录规范媒体类型、字节数、宽高和编码版本，供下载响应、恢复校验及未来迁移使用。

“完整解码后再编码”是纵深防御，不代表解码库永远没有漏洞；仍需维护 Go 安全更新并在资源上限内执行解码。OWASP 同样强调上传安全没有单一银弹，应组合多层控制。[OWASP File Upload Cheat Sheet：Introduction](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html#introduction)

### Wayfinder 产品待决策

- 输入白名单是否只接受 JPEG、PNG，还是还接受 GIF/WebP；输出是否统一为 JPEG、PNG 或两者。
- 请求上限、原图字节上限、最大宽高、最大像素数、长宽比、输出尺寸、JPEG 质量和 PNG 压缩参数。
- MIME/扩展名不一致时是直接拒绝，还是只以真实解码格式为准并记录审计事件。
- 是否保留原图。若没有明确业务需求，安全边界最小的选择是只保留标准化头像，不保留原字节。

## 2. SVG、动画、元数据和资源耗尽风险

### 外部事实

- SVG 1.1 定义了与 HTML `script` 类似的脚本元素，也允许事件属性执行脚本。SVG 因此不是普通的被动栅格字节；安全性取决于它被嵌入或导航到的上下文。[W3C SVG 1.1：Scripting](https://www.w3.org/TR/SVG11/script.html)
- GIF 可以包含多帧和每帧延时；Go `gif.Decode` 只返回第一张图，而 `gif.DecodeAll` 才返回全部帧、延时和循环信息。因此只调用 `Decode` 会把“可解码”误当成“单帧”。[Go `image/gif`](https://pkg.go.dev/image/gif)
- PNG 第三版把 APNG 定义为与普通 PNG 向后兼容的动画格式；不理解动画块的解码器仍可显示静态表示。规范还指出静态图和动画帧可能不同，这会形成内容审核绕过风险。[W3C PNG 3：APNG](https://www.w3.org/TR/png-3/#apng)
- PNG 的 `eXIf` 块可以携带相机生成的 EXIF 元数据；W3C 特别指出 EXIF 可能包含 GPS 位置等隐私信息，JPEG/JFIF 也存在相同风险。[W3C PNG 3：Security and privacy considerations](https://www.w3.org/TR/png-3/#13Security-considerations)
- Go 图片安全说明指出，小的压缩图片可能在解码时需要非常大的内存；处理不可信图片前应先用 `DecodeConfig` 检查尺寸。Go `image` 包也提醒任意大图片可能导致资源耗尽。[Go Security：Large image parsing](https://go.dev/doc/security/decisions#image-large-images)；[Go `image` Security Considerations](https://pkg.go.dev/image#hdr-Security_Considerations)
- OWASP 要求限制上传大小，并在处理压缩内容时考虑解压后的大小；这支持同时设置“编码字节上限”和“解码像素/尺寸上限”，不能只设其中之一。[OWASP File Upload Cheat Sheet：Upload and Download Limits](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html#upload-and-download-limits)

### 推荐边界（工程推导）

- 普通头像通道排除 SVG。若未来确有 SVG 业务需求，应建立独立的清洗、渲染、隔离来源和响应策略，不能把“扩展名为 `.svg`”当成安全依据。
- 若产品只允许静态头像，接受 GIF 或 PNG 后只做一次通用解码还不够：GIF 需识别多帧；PNG 需考虑 APNG。最简单且可验证的边界是把首个认可的像素结果重新编码为静态 JPEG/PNG，并只存储该输出；若不希望悄悄丢失动画，则在再编码前明确检测动画并拒绝。
- 再编码可去掉原文件的 EXIF、文本块和其他非像素载荷；但 JPEG EXIF Orientation 可能决定原图应如何旋转。Go 标准库 JPEG API没有承诺读取并应用 EXIF 方向，因此产品必须决定是先使用受控元数据解析器应用方向再剥离，还是要求客户端提交已校正像素。
- 使用独立的请求字节、编码文件字节、宽、高、总像素及输出尺寸上限。即使文件很小，只要声明或解码尺寸超限也应在完整解码前拒绝。

### Wayfinder 产品待决策

- “静态头像”是否是硬性产品约束；检测到 GIF/APNG 动画时拒绝还是静态化。
- 是否完全禁止 SVG；若不禁止，谁负责 SVG 清洗器、CSP/独立来源和回归安全测试。
- EXIF Orientation 的处理规则，以及是否向用户明确说明所有 EXIF/GPS/文本元数据都会删除。
- 各资源上限和超限错误码；是否在进程内解码，还是将高风险图片处理隔离到受限工作进程。

## 3. 文件名、路径、存储位置与 HTTP 响应

### 外部事实

- OWASP 建议由服务端生成随机文件名（例如 UUID/GUID），限制文件名长度和字符；优先把文件放在独立主机，次选 webroot 外，并通过应用处理器映射访问。[OWASP File Upload Cheat Sheet：Filename Safety、File Storage Location](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html#filename-safety)
- Go `filepath.IsLocal` 是纯词法检查：它能排除绝对路径、空路径和 `..` 逃逸，但不考虑符号链接。它适合校验一个相对路径片段，却不能单独证明解析后的实际文件仍在根目录内。[Go `path/filepath.IsLocal`](https://pkg.go.dev/path/filepath#IsLocal)
- Go 1.24 引入的 `os.Root`/`os.OpenRoot` 把文件操作限制在给定目录内，并阻止路径或符号链接逃逸；项目若使用更早 Go 版本则不能依赖该 API。[Go `os.Root`](https://pkg.go.dev/os#Root)；[Go `os.OpenRoot`](https://pkg.go.dev/os#OpenRoot)
- `os.CreateTemp` 创建带随机后缀、权限为 `0600` 的新临时文件，调用者负责删除；`O_CREATE|O_EXCL` 可要求目标不存在，避免覆盖已有不可变对象。[Go `os.CreateTemp`](https://pkg.go.dev/os#CreateTemp)；[Go `os.O_EXCL`](https://pkg.go.dev/os#O_EXCL)
- `os.Rename` 的跨目录限制取决于操作系统，而且 Go 文档明确说明：即使在同一目录，非 Unix 平台上的 `Rename` 也不是原子的。因此 Windows 上不能把“临时文件改名”当成跨平台原子发布保证。[Go `os.Rename`](https://pkg.go.dev/os#Rename)
- `http.ServeContent` 在响应未设置 `Content-Type` 时会先按文件名扩展名推断，再嗅探内容。对于上传文件，这会把响应类型重新交给文件名/嗅探规则；应用应从已验证元数据显式设置规范类型。[Go `net/http.ServeContent`](https://pkg.go.dev/net/http#ServeContent)
- WHATWG Fetch 定义 `X-Content-Type-Options: nosniff`，但其阻断算法只对脚本类和样式类请求目标生效。它不能替代正确的图片 `Content-Type`，更不能验证上传内容。[WHATWG Fetch：X-Content-Type-Options](https://fetch.spec.whatwg.org/#x-content-type-options-header)

### 推荐存取模式（工程推导）

- 原始文件名只进入经过长度限制和转义的审计字段；磁盘位置由服务端不透明 `file_id` 映射，不允许用户提交目录、绝对路径或分隔符。
- 头像目录位于 webroot 外，且只有服务账号可写。读取只能通过应用处理器按数据库中 `ready` 文件记录定位；未被引用或仍在写入的对象不对外可见。
- 若 Go 版本允许，优先用 `os.Root` 执行根内操作；否则只接受服务端生成的单一文件名组件，辅以 `IsLocal`，并避免可被不可信主体创建的符号链接。无论哪种方式，都不要把用户字符串直接传给 `ServeFile` 或 `os.Open`。
- 为每个完成对象使用新 ID 和排他创建，不覆盖已有路径。写完后 `File.Sync`、关闭，再允许数据库产生 `ready` 引用；`File.Sync` 的文档范围只是把该文件当前内容提交到稳定存储，并不与数据库事务形成共同提交。[Go `os.File.Sync`](https://pkg.go.dev/os#File.Sync)
- 响应使用已记录的规范媒体类型（例如 `image/jpeg` 或 `image/png`），附 `X-Content-Type-Options: nosniff`；不要根据原始文件名动态决定类型。头像是否公开、鉴权方式、缓存策略另行决定。

### Wayfinder 产品待决策

- 不透明 ID 的格式和随机源、磁盘分片布局、最终扩展名是否保留，以及 Go 最低版本是否允许使用 `os.Root`。
- 头像是公开资源还是受鉴权资源；缓存期限、ETag/摘要、内容处置和跨域策略。
- 文件目录权限、运行账号、磁盘配额和文件系统满时的降级/告警行为。

## 4. PostgreSQL 与文件系统的非原子生命周期

### 外部事实及边界

- PostgreSQL 事务把一组数据库步骤作为一个全有或全无的单元，并通过 `COMMIT` 或 `ROLLBACK` 决定数据库状态。[PostgreSQL：Transactions](https://www.postgresql.org/docs/current/tutorial-transactions.html)
- Go 的文件创建、写入、同步、关闭、改名是独立的操作系统调用；PostgreSQL 的事务文档没有把任意应用文件纳入其提交。由两套接口的边界可推得：在未引入专门的跨资源事务协调器时，应用不能把数据库行和本地文件作为一个原子事务提交。
- PostgreSQL 外键能维护数据库表之间的引用完整性，但它不知道 webroot 外某个本地路径是否存在。因此外键可保护“文件元数据行与头像/历史记录行”的关系，不能保护“元数据行与物理文件”的关系。[PostgreSQL：Foreign Keys](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK)
- 临时文件的清理由调用者负责；进程崩溃、文件写成而数据库回滚、重试换用新 ID 都可能留下孤儿。[Go `os.CreateTemp`](https://pkg.go.dev/os#CreateTemp)

### 推荐的同步发布模式（工程推导）

目标是选择可补偿的失败方向，而不是声称跨资源原子：

1. 生成从未使用过的不可变 `file_id`，在私有最终位置用排他创建开始写入。此时数据库没有任何可服务引用。
2. 完成校验、标准化、摘要计算、写入、`Sync` 和关闭。进程若在此期间失败，只会留下没有数据库引用的部分文件或孤儿；它们不得被应用处理器服务。
3. 开启 PostgreSQL 事务，插入 `ready` 文件元数据，并把用户当前头像指针切换到新 ID；需要保留的快照/历史引用也在同一事务中写入。
4. 数据库事务失败时，不在请求路径里冒险删除刚写文件；把它当作孤儿，由带宽限期的清理任务处理。数据库成功时，新引用只指向已完成文件。
5. 不在同一请求中立即删除旧文件。替换只切换引用，旧对象由后续的全局可达性检查决定是否可回收。

该模式不依赖 Windows 上没有保证的原子 `Rename`。如果实现仍采用 `staging` 目录和发布改名，必须把发布操作的失败当成显式状态处理，且只能在发布成功后创建 `ready` 引用。

### 可选的异步状态机（产品设计候选）

若图片处理不能在请求内完成，可在一个 PostgreSQL 事务内创建 `pending` 文件记录和持久任务；幂等 worker 生成不可变文件，确认文件完成后再用第二个数据库事务标记 `ready` 并切换头像指针。超时 `pending` 可重试或标记失败，其临时/孤儿文件仍由清理器处理。这里的 `pending → ready → retired/deleted` 是产品状态机，不是 PostgreSQL 或 Go 标准库自动提供的能力。

### Wayfinder 产品待决策

- 采用同步的“文件先完成、数据库后引用”，还是引入 `pending` 任务状态机；每一状态的重试、超时和可见性规则。
- 文件摘要算法、写入重试的幂等键、同一个用户并发替换时的乐观锁/版本条件。
- 启动时和周期性对账频率，孤儿宽限期，部分文件/未知文件的隔离目录，以及磁盘满和数据库不可用时的补偿策略。

## 5. 不可变文件 ID、替换、历史引用与回收

### 外部事实及边界

- OWASP 建议服务端生成文件名；Go 的排他创建可以避免意外覆盖。两者支持“新内容写到新名字”的实现，但没有任何上述标准规定 TTSync 的头像 ID、历史保留期限或 GC 算法。[OWASP Filename Safety](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html#filename-safety)；[Go `os.O_EXCL`](https://pkg.go.dev/os#O_EXCL)
- PostgreSQL 外键只能覆盖建模为关系行的引用。若某些历史引用只存在于 JSON、日志、导出文件或拼接 URL 中，数据库外键和简单引用计数都不会自动看见它们。[PostgreSQL：Foreign Keys](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK)

### 推荐对象模型（工程推导）

- 把“头像槽位”和“文件对象”分开：用户当前头像只是指向不可变 `file_id` 的指针；物理文件对象包含摘要、规范 MIME、大小、宽高、状态和创建时间。
- 替换头像总是创建新 `file_id`，数据库事务只移动“当前头像”指针。已经冻结显示信息或文件引用的比赛快照继续指向旧 ID，避免覆盖同一路径导致历史页面悄悄变化。
- 删除头像首先移除或改变逻辑引用；物理删除延后。只有确认所有权威引用根均不可达、对象超过宽限期并且不受备份/恢复保留策略保护时，才可回收。

### 引用计数与可达性 GC 的取舍（产品设计候选）

- **引用计数**：读取和候选筛选快，但正确性要求每一种引用的增减都和业务事务一起更新；漏掉快照、软删除、导入数据或手工修复中的一种引用，就可能过早删除。
- **可达性 GC**：在一致的数据库快照上枚举所有权威引用根，标记仍可达的 `file_id`；对未标记且超过宽限期的对象先隔离，再在下一轮复核后删除。它能顺带发现“文件已写、数据库提交失败”的孤儿，也能纠正引用计数漂移，但扫描成本更高。
- **推荐组合**：数据库内所有结构化引用使用外键；引用计数只作优化或候选索引；最终物理删除以全根可达性扫描、宽限期和二次复核为准。隔离期内文件可恢复，正式删除后按备份保留策略恢复。

### Wayfinder 产品待决策

- 所有权威引用根清单：当前用户头像、成员资料、比赛快照、审计记录、软删除数据、导出/导入暂存等哪些会持有文件 ID。
- 快照究竟冻结 `file_id` 还是冻结显示用的派生头像副本；旧头像的最短保留期和合规删除规则。
- 选择纯可达性 GC、引用计数加对账，还是其他实现；扫描周期、宽限期、隔离期、批量上限和人工恢复入口。

## 6. 本地文件备份与恢复的一致性边界

### 外部事实

- `pg_dump` 导出的是其开始时点的内部一致 PostgreSQL 快照，并可在数据库并发使用时运行；它只导出 PostgreSQL 数据库对象和数据，不会自动把应用的头像目录纳入同一个快照。[PostgreSQL：SQL Dump](https://www.postgresql.org/docs/current/backup-dump.html)
- PostgreSQL 对自身数据目录的文件系统级备份要求服务器停机，或使用能取得一致冻结快照的文件系统；当数据跨多个文件系统时，快照必须同时取得。这说明一致性快照有明确边界，不能把不同时间普通复制的多个存储域默认为同一时点。[PostgreSQL：File System Level Backup](https://www.postgresql.org/docs/current/backup-file.html)
- `File.Sync` 只承诺提交单个文件的当前内容；它没有冻结头像目录，也没有冻结 PostgreSQL 快照。[Go `os.File.Sync`](https://pkg.go.dev/os#File.Sync)

### 两种可验证的备份模式（工程推导）

**模式 A：暂停写入的一致代备份**

1. 暂停上传、替换、删除和 GC，等待在途写入完成。
2. 取得 PostgreSQL 备份并复制/快照头像目录，生成同一个 `backup_generation` 清单（数据库备份摘要、文件清单、每文件摘要和编码版本）。
3. 备份完成后再恢复写入和 GC。此模式边界最清晰，代价是写入暂停窗口。

**模式 B：在线的不可变对象备份**

1. 持续满足“文件完整并同步后，数据库才可提交引用”；已有 `file_id` 永不覆盖。
2. 先启动/完成 `pg_dump` 取得数据库逻辑快照，再复制整个不可变文件集合；在文件复制和清单固化完成前冻结物理删除与 GC。
3. 因为数据库快照中每个已提交引用的文件都在提交前完成，而且期间没有删除，后取得的文件集合应覆盖快照所需文件；快照之后新建的额外文件可以作为无害多余对象随备份存在。
4. 若只复制“当前在线数据库可达”的文件，而不是整个集合或根据该次数据库快照导出的精确清单，并发替换可能漏掉备份快照仍引用的旧对象，因此不可这样优化。

模式 B 的覆盖结论依赖上述顺序和不可变/冻结删除不变量；若实现不能证明这些不变量，应使用模式 A 或支持跨存储同时快照的基础设施。

### 恢复验收（工程推导）

- 数据库备份和文件清单必须按同一个 `backup_generation` 成对恢复，不能混用不同批次。
- 恢复后、对外服务前，枚举全部 `ready` 及业务/历史引用，验证文件存在、大小和摘要一致；缺失或摘要不符是恢复失败，不能静默降级为默认头像后宣称恢复成功。
- 对清单内但数据库不可达的文件先隔离，不要立即删除；它们可能是允许的在线备份“额外对象”，经宽限期和二次可达性检查后再 GC。
- 定期执行真实恢复演练，记录数据库引用数、缺失文件数、摘要错误数、额外文件数和恢复耗时。

### Wayfinder 产品待决策

- 采用模式 A 还是模式 B；备份代号、RPO/RTO、频率、保留周期、加密和异地副本策略。
- 在线备份期间如何冻结 GC，如何发现并恢复过期冻结，以及磁盘空间不足时是否中止备份。
- 恢复时对缺失头像是否允许有标记的降级运行，还是必须阻止服务启动；谁批准清理额外文件。

## Wayfinder 决策票建议至少固定的字段

这些字段均是产品/架构选择，而不是外部规范已经替 TTSync 决定的答案：

1. 输入/输出格式、动画与 SVG 策略、EXIF Orientation 和元数据策略。
2. 请求字节、文件字节、宽、高、总像素、输出尺寸和处理时限。
3. `file_id`、磁盘布局、Go 最低版本、目录权限、服务响应头和访问/缓存规则。
4. 同步发布或异步状态机、每个失败点的补偿、对账及孤儿宽限期。
5. 替换语义、历史/快照引用根、物理删除条件及 GC 算法。
6. 备份一致性模式、GC 冻结协议、备份代清单和恢复验收门槛。
