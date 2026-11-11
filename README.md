# 文库档案

一个文件驱动的书库。React + Vite 前端，Node.js 文件服务与 API；不依赖数据库。下载完整文件后，将 JSON 元数据和书稿发布进目录，页面自动发现新书。可本地使用，也可公开部署；公开书库无需登录，注册和登录仅需账号、密码、图片验证码，扫描、下载和导入仅限管理员。

源码以 MIT 许可证分享。仓库包含完整程序、原创示例、测试与部署模板；运行书库、来源站 Cookie、实际任务队列和管理凭据留在 Git 之外。公开部署说明见 [docs/deployment.md](docs/deployment.md)。

在线站点：[公开书库](http://111.229.32.85/#/library) · [注册](http://111.229.32.85/#/register) · [登录](http://111.229.32.85/#/login) · [任务管理](http://111.229.32.85/#/tasks)。阅读无需登录；任务管理需要管理员账号。源码仓库附带一份原创示例，站点运行书库独立保存。该地址目前使用 HTTP，生产使用建议在反向代理配置 HTTPS。

## 启动

需要 Node.js 22 或更新版本。

    npm ci
    npm run setup
    npm run build
    npm start

打开 http://127.0.0.1:4178。Windows 也可双击 start.cmd。

setup 只补齐缺失目录、默认队列和原创示例，保留已有书库与断点。首次安装的任务队列为空且暂停；请按自己的使用权限配置任务，再通过网页启动。

开发模式：npm run dev。端口可使用 npm start -- --port 4180，书库目录可使用 --library D:\Books；也可设置 ARCHIVE_PORT、ARCHIVE_LIBRARY。服务默认只绑定 127.0.0.1。

生产模式必须运行 Node 服务；仅把 dist 放进静态托管服务，不能自动读取磁盘书库或接收新书。增加书籍不需要再次构建前端。

## 命令行工具 nikowenku-archive

提供三个核心命令：`search` 搜索本站公开书库，`info` 查看书籍详情，`download` 将正文保存到指定文件。安装后默认连接公开书库，不需要启动本地 Web 服务：

```sh
node scripts/cli.mjs search "星" --site http://111.229.32.85
node scripts/cli.mjs info wenku8-934 --site http://111.229.32.85
node scripts/cli.mjs download wenku8-934 --site http://111.229.32.85 --output "./雾岛来信.txt"
```

可从书库首页下载独立 CLI 安装包，或在源码项目目录执行 `npm link`。安装包包含 `nikowenku-archive` 命令：

```sh
npm install -g ./nikowenku-archive-0.1.0.tgz
nikowenku-archive search "星" --limit 10
nikowenku-archive info wenku8-934 --json
nikowenku-archive download wenku8-934 --output "./雾岛来信.txt"
nikowenku-archive --help
```

默认连接公开书库 `http://111.229.32.85`，也可设置 `ARCHIVE_SITE_URL` 或传入 `--site <网址>`。用 `--local` 或 `--library <目录>` 切换到本地书库；本地模式默认使用当前目录下的 `library/`，索引目录为 `.state/`。源码项目内的本地模式可使用 `npm run archive -- search "星" --local`。

搜索匹配书名、原名、作者、简介和标签，结果包含用于后续命令的书籍 ID；默认显示前 20 条，用 `--limit` 调整为 1–100 条。三个命令都支持 `--json`。`download` 保持正文原始字节和编码，默认保存到当前目录的 `<book-id>.<原扩展名>`，输出文件已存在时会报错；确认需要替换时加 `--force`。它只下载书库中已发布的正文，不会向来源站创建采集任务。

## 放入一本书，直接上架

    library/
      my-book/
        book.json
        content.txt
        cover.jpg        可选
        original.epub    可选附件

最小 book.json：

    {
      "id": "my-book",
      "title": "书名",
      "author": "作者",
      "description": "内容介绍。",
      "updatedAt": "2026-11-09",
      "files": { "text": "content.txt" }
    }

将目录放入 library 后，页面每 5 秒自动更新，也可以点击“重新扫描”。不用修改代码、不用重新构建、不用重启服务。也支持平铺结构：library/my-book.json 和 library/my-book.txt。

书库列表每页显示 24 本，搜索、分类和排序仍针对全部已入库书籍。目录扫描使用有限并发、元数据缓存和共享的扫描请求，API 对短时间内的读取缓存 4 秒；目录未变化时以 ETag / HTTP 304 响应，避免重复传输整份书目与重绘。自动刷新不会叠加请求，“重新扫描”可跳过目录缓存。封面、正文和章节访问只重新校验目标书籍及其文件，不再触发全库遍历。新文件最迟在缓存到期后的下一次轮询被发现，通常约 5 秒、极端约 9 秒加扫描耗时。

正文必须完整写入后再发布 JSON。推荐先使用 .part 下载，完成后重命名；元数据写入放在最后。published: false 可暂时隐藏草稿。缺少正文、空文件、损坏的 JSON 和重复 ID 会出现在“待完善”提示中，不会让其他书籍失效。

完整字段模板：public/book-template.json。结构说明：schema/book.schema.json。

支持书名、原名、作者/多作者、译者、插画、更新时间、内容介绍、分类、标签、语言、出版方、出版年、ISBN、版本、来源及来源更新时间、权利说明、卷数、章数、字数、封面和附加文件。未知扩展字段会保存在原始 JSON，并展示于书籍详情的“全部元数据”中。

正文支持 UTF-8、GBK、GB18030、UTF-16 等编码，默认 auto；推荐明确设置 encoding。卷章目录从完整正文自动生成，没有分章标记时提供“全文”。原始 TXT 保持原样，目录解析结果只是阅读视图，不改写原文件。

## 三种发布方式

1. 直接把完整 JSON + 文件目录放进 library。
2. 页面“导入书籍”：一起选择 JSON、TXT 及可选的封面、EPUB/PDF。文件名须与 JSON 中 files 对应。
3. 命令行发布已有文件：

    npm run publish:book -- --manifest examples/xiyouji.json --text "C:\Books\西游记.txt"
    npm run publish:book -- --manifest book.json --text full.txt --cover cover.jpg

Web/CLI 导入使用临时目录原子发布，全部写入完成后才上架；同一个 ID 不会静默覆盖。更新已有书籍，可直接修改其目录中的正文/元数据。

## 直接下载全本

下载器不逐章抓取，也不会自动遍历整站。输入一份书籍元数据，给出该书的完整 TXT 下载入口，即可下载、验证、发布。只处理有权保存和使用的内容。

### 从文库书籍页准备资料并发布

站点适配器接受书籍编号或资料页网址，读取书名、作者、分类、状态、更新时间、介绍、标签、来源字数、最近章节、封面地址，以及页面实际展示的 TXT 全本入口。

    npm run source:wenku8 -- 934 --cookies secrets/wenku8.cookies.json
    npm run source:wenku8 -- "https://www.wenku8.net/book/934.htm" --cookies secrets/wenku8.cookies.json --download

第一条仅准备资料；第二条准备后调用整本下载器，成功后自动上架。资料保存在 .state/prepared/wenku8-934.json，只有完整正文下载并验证成功才写入 library。已上架的同一 ID 会跳过，不会因为候选语言有多个就重复下载多份。

每本只下载一个版本：优先简体中文，缺少简体再用繁体，两者都没有才使用其他语言。本站当前解析规则识别其实际展示的中文 TXT 全本格式；不会凭空生成其他语言入口。简体版本内优先 UTF-8，其次 GBK；仅取一个下载节点。URL 的 type=big5 是本站繁体版本标识，不将它误当成该文件的实际编码；页面标为 U 的版本按 UTF-8 处理。

如正常登录的浏览器能打开页面，但纯 HTTP 请求被验证拦截，可在浏览器保存资料页和 TXT 全本页，再交给同一适配器解析：

    npm run source:wenku8 -- 934 --html saved-info.html --downloads-html saved-full.html --download --cookies secrets/wenku8.cookies.json

下载页必须是 type=txtfull 的全本页面；分卷页、登录页和验证页不会生成有效下载任务。此功能不解决验证码或登录问题。封面地址保存在 source.coverUrl；下载全文时会一并获取该地址的封面，验证图片内容后按实际格式保存为 cover.jpg/png/gif/webp，并写入 files.cover。图片和 JSON、正文一起原子上架，读者页面通过本机接口显示图片。图片请求不附带账号 Cookie，遵守同一个随机请求间隔；单张默认上限 8 MB、超时 20 秒。封面缺失、网络失败或返回非图片页面不会阻止完整正文上架；图片服务器返回 429 时正文保留，后台保存冷却时间后暂停请求。

已有书籍可单独补封面，无须重下正文：先执行 `npm run download:stop`，再执行 `npm run covers:backfill`，最后执行 `npm run download:start`。补图只更新本地图片与元数据，保留正文字节、完整性校验、语言和原上架时间；已有本地图片会跳过。结果保存在 `.state/cover-backfill-result.json`。只有来源资料中提供封面地址的书籍才会请求图片，不猜测封面下载链接。

单本示例：

    npm run download:full -- examples/xiyouji.json

示例元数据包含 downloadUrl。也可直接传入：

    npm run download:full -- book.json --url "https://example.org/full.txt"

批量任务：将多个同结构的元数据对象放进 JSON 数组。

    npm run download:full -- queue.json --cookies secrets/cookies.json --min-delay 3 --max-delay 8

每本只取整本文件；请求之间随机等待 3–8 秒。默认最多 3 次尝试，支持 --attempts。已上架 ID 会跳过，重跑即从未完成任务继续。这里的“续跑”是任务级恢复，不是 HTTP 字节级断点续传。状态在 .state/download-state.json；Ctrl+C 可停止。

可以用 --state-dir 指定独立任务状态目录。单本 source:wenku8 命令对每个入口只尝试一次，避免在结果不明确时重复获取整个文件；明确缺失（404/410）才继续下一个已提供入口。

### 常驻队列自动发布

导航中的“扫描与下载”打开独立任务页面（`#/tasks`），书库首页仅展示书籍。任务页面已内置后台控制：点击“启动任务”开始扫描和下载，点击“停止任务”安全停止，之后可从断点继续。每次启动时会检查队列中已有的文库来源书籍；来源更新时间、字数或最近章节发生变化时，重新获取并校验全文，再替换本地版本。检测或下载失败时保留原书。面板每 2 秒更新扫描编号、已检查范围、当前书名、下载阶段、已接收字节、待下载数、已上架数、缺失与失败数。服务器提供 Content-Length 时显示当前文件百分比；总大小未知时显示实际接收量和处理中状态。最近任务记录可以展开查看。切换页面或关闭网页不会停止后台进程。

网页和命令行共用同一份队列、状态与进程锁，重复点击启动不会创建多个下载进程。控制接口只接受本地同源请求，不接受用户传入命令或文件路径，状态接口不返回 Cookie、进程锁令牌、凭据路径或完整内部状态。服务默认使用项目的 download-queue.json 和 .state；自定义实例可给 server/index.mjs 传入 --queue 和 --state-dir。

当前实例开启 `"autoDiscover": true`：点击网页“启动任务”即可独立完成新编号检查、断点扫描、全本下载和本地上架，不依赖聊天触发。每次启动检查一次站点“最新入库”列表，之后按 `discoveryIntervalSeconds`（默认 1800 秒，即 30 分钟）定期检查。发现更高编号时，在状态文件中保存已知最大编号并自动扩展最后一个 metadata 范围，不修改原始队列，也不重置已处理任务。页面分母表示当前已知扫描范围，并非全站书籍总数；页面会显示自动发现状态、已发现最大编号、下次检查时间和重试提示。

新书列表暂不可读取时保留已知范围，至少一分钟后自动重试，既有编号继续处理。登录失效或 429 会暂停整个队列，更新 Cookie 或限速结束后恢复。新编号检查也使用共同的请求间隔和扫描工位；停止任务会取消检查。自动发现仅依据站点列出的真实书籍编号，不能保证发现未被列表展示的隐藏编号；仍遵守单队列展开最多 10000 项的限制，超过时显示重试提示并保留可用范围。关闭网页不影响检查，关闭后台任务或计算机关机后需要再次点击启动。

持续处理队列并在完成校验后将 JSON + 全本文本原子发布到书库：

    npm run download:watch

这个前台命令适合调试，Ctrl+C 会安全停止。Windows 可用以下命令在后台启动、检查、停止：

    npm run download:start
    npm run download:status
    npm run download:stop

单次执行当前能立即运行的任务：

    node scripts/watch-library.mjs --once

书单位于 download-queue.json。每项填写 manifest 文件或内嵌完整元数据；要处理文库来源的单本任务，可用 `{ "source": "wenku8", "bookId": "书籍编号" }`，授权 Cookie 取自本机 secrets/wenku8.user.cookies.json。保存书单后脚本会在最多一个轮询间隔内识别新任务；暂停全队列可设 `paused` 为 true。一次后台任务正在运行时，修改设置会在下一轮生效。

任务清单应为有权保存和使用的内容：例如自有稿件、已授权文本和明确公版文件。examples 目录保留《西游记》《三国演义》公版全文的来源元数据；默认新实例使用空队列，已上架任务会跳过。入口缺少简体候选时会直接选繁体，再考虑其他语言；有简体入口但返回 404/410 时才会继续下一候选，成功下载一个版本就结束。页面标明实际下载语言。

登录/验证失败会暂停全队列；更新本地 Cookie 文件后自动恢复。临时错误按 Retry-After 和递增延时重试，超过次数的任务在修改该任务配置或添加、递增 `retryToken` 后重新执行。全局 `resumeToken` 用于显式恢复登录暂停或重置失败任务；已上架任务仍会跳过。状态和日志在 `.state/worker-state.json` 及 `worker.*.log`，不包含 Cookie 内容。通过 `--queue`、`--library`、`--state-dir` 可以指定其他位置；每份独立队列使用独立状态目录。

后台进程在当前 Windows 会话持续运行，关闭终端不会中断；计算机重启后需要重新执行 `download:start`。暂停、停止和退出均为任务级续跑，未完成文件下次从头下载。完成校验与原子发布后，当前网页约 5 秒内显示新书；这里的发布指写入本地书库，不会上传到外部服务器。

### 两个并发任务与随机请求间隔

当前 download-queue.json 配置 `"concurrency": 2`，最多同时处理两个任务，一个完成后会立即补上下一个。省略该设置时保持单任务模式；只接受整数 1 或 2。资料扫描和全本下载共用这两个位置；同一本书仍只保存一个优先语言版本。

默认队列还设置了 `"workerSlots": { "scan": 1, "download": 1, "update": 1 }`：scan 和 download 的容量合计等于 concurrency；update 是额外独立的书籍更新工位，不占用这两个位置，设为 0 可关闭更新检测。更新请求仍与其他请求共用随机间隔限制。省略 workerSlots 则恢复 scan/download 两路共享；update 工位仍默认为 1。

所有任务共用一个请求调度器。`minDelaySeconds` 和 `maxDelaySeconds` 控制相邻 HTTP 请求开始时间的随机间隔，当前为 3–8 秒；资料页、全本页、正文、重定向和语言回退都经过同一调度器。并发不会把请求频率翻倍，也不会等待一个文件全部传输完才允许另一个任务开始。随机间隔仅用于限制请求频率，不伪装浏览器或绕过站点验证。

登录失败和 429 限速会取消其他任务中尚未完成的传输或等待请求，并暂停整个队列；取消的任务保留为 pending，下次重新从完整文件开始。安全停止会同时结束两个任务。状态中的 `concurrency` 是并发上限，`activeBookIds` 是当前任务编号列表；`progress.downloading` 与 `progress.discovering` 分别统计下载和资料扫描。并发状态写入按顺序执行，书籍仍在文件校验与原子发布后才上架。

状态中的 `workers.scan` 与 `workers.download` 分别返回容量、实际活动编号、待处理数、完成数和运行状态。全文队列为空时下载一路显示 `waiting_for_tasks`，不会把扫描记录当成已下载小说。新增有权使用的全本下载任务后该路会自动执行，无须暂停另一侧的扫描。

启用 `"downloadDiscovered": true` 后，metadata 范围变为“扫描后自动下载”的流水线：扫描工位保存书目资料，下载工位立即接收已发现编号，按真实全本页面的语言优先级只保存一个全文版本。此前已保存的书目也会自动补入，不需要从编号 1 重新扫描。下载优先复用 `.state/catalog` 中的资料，缺少缓存时才重新读取资料页；全文入口仍从实际下载页解析。省略该选项或设置 false 时保持只扫描资料的行为。

每本书的 `scanCompletedAt` 独立保存扫描结果；即使该书正在下载、等待重试或已上架，扫描断点也不会退回。扫描完成数和下载完成数分别计算，网页书籍数只在完整正文通过校验后增加。自动交接选项只改变工位路由，不重置现有任务指纹、失败重试或认证暂停。

### 按数字编号持续处理

文库数字编号可直接作为 `books` 的元素，例如 `"books": [934, 1, 2]`；这等价于逐项填写 `source: "wenku8"` 和 `bookId`，并使用队列顶层的 Cookie 文件与网络设置。每个编号会先读取真实资料页，再从全本页选择一个完整文件，不猜测正文下载链接，也不逐章抓取。

编号范围使用 `ranges`，无需手写成千上万个任务。下面是**仅保存书目资料**的配置：

```json
{
  "books": [],
  "ranges": [
    { "source": "wenku8", "startId": 1, "endId": 100, "mode": "metadata" }
  ]
}
```

对于有权保存和使用全文的编号清单，将对应项的 `mode` 设为 `download`，处理链即为资料、全本入口、语言选择、整本下载、校验和自动上架。`metadata` 模式只将书名、作者、更新时间、介绍、标签、来源等资料保存到 `.state/catalog/wenku8-编号.json`，状态为 `discovered`；不会请求或发布全文，不会增加网站中的可读书籍数量。省略范围的 mode 时默认 metadata；单个 books 数字默认 download。两种模式明确区分，书目资料不冒充已下载小说。

范围按编号递增派发任务；并发开启时完成顺序可以不同。已有全文跳过，明确不存在或已删除的编号记为 `missing` 后继续；未知页面结构记为失败，登录验证会暂停整个队列。429 限速响应会暂停整个队列并遵守 Retry-After，不能通过请求下一个编号跳过限速。完成、缺失、失败和待处理状态持久保存，重启不从头请求；延长 endId 会自动加入新增编号。显式 books 项优先于范围中同号任务，重叠范围会去重。单份队列展开前最多 10000 项，避免无界遍历。

`download:status` 返回 `progress` 汇总（published、discovered、missing、failed、pending 等）和活动 ranges；只看 running 不能判断脚本是否实际下载。默认队列的编号范围是书目资料扫描；网站已上架总数仍仅统计有完整正文的书籍。

扫描断点保存在同一状态文件的 `scanCheckpoints`，包含每个 metadata 范围的 `lastCompletedId` 和 `nextId`。它由逐编号持久状态推导：完成、已记录缺失和永久失败的任务不会因进程重启重新请求；尚未完成的活动编号回到 pending，下次先重试这个编号，再继续后面的编号。断点不会跳过中途未完成的空洞。`nextId: null` 表示该范围全部处理完毕。修改并发和 workerSlots 不改变单本任务指纹，不会清空已经扫描的状态。

Windows 上如果状态文件被读取句柄短暂占用，原子替换会对 EPERM/EACCES/EBUSY 做有限退避重试；持续占用仍会报告错误并保留旧断点，不通过先删除状态文件来完成替换。

### 语言优先级

默认简体中文优先，其次繁体中文，再其次其他语言。同一本书有多个完整 TXT 入口时，在下载任务 JSON 中填写 downloadVariants：

    "downloadVariants": [
      { "language": "ja", "url": "https://example.org/original.txt" },
      { "language": "zh-Hant", "url": "https://example.org/traditional.txt", "encoding": "utf-8" },
      { "language": "zh-Hans", "url": "https://example.org/simplified.txt", "encoding": "utf-8" }
    ]

数组顺序不影响语言优先级；没有简体候选才选繁体，没有中文候选才选其他语言。同级候选按填写顺序选取。downloadUrl 作为另一候选参与比较；显式 --url 则以该指定地址为准。选中入口若返回 404/410（文件不存在），才按顺序尝试下一个已提供的入口；成功保存一个正文后立即结束，不会继续下载其他语言。不同候选请求之间仍遵守随机间隔。

这是已提供入口之间的选择，不自动搜索其他网站。登录失败、验证码、除文件不存在以外的 HTTP 错误或校验失败依旧报错，不会用切换语言掩盖失败。下载后的 language 和 encoding 取自实际成功下载的版本，版本校验值应写在对应候选的 integrity 中。只写 zh 不会被误标为简体；不知道具体简繁时请如实填写。

书库默认“简体中文优先”排序，同语言再按更新时间排列；最近阅读仍按阅读时间排列。卡片与详情明确显示正文语言。原文保持原样，不将繁体文本自动转为简体后冒充来源版本。当前《西游记》演示文件是来源提供的繁体全文，因此标注为繁体中文。

401、403、登录/验证 HTML、文件校验失败不会发布，并停止该任务。429/503 等临时失败会重试，并在有 Retry-After 时等待。文件默认最大 64 MB，正文在线阅读最大 128 MB。

### 登录态

将 Cookie 保存在本机 secrets/cookies.json。支持 Playwright storageState 对象、浏览器导出的 Cookie 数组，以及只含 Cookie 头值的本地文本文件；不要求提供账号密码。

Cookie 会按域名、路径、有效期和 HTTPS 属性选择；重定向到其他域名时不会无条件转发原始 Cookie。纯文本 Cookie 仅作用于最初下载地址的相同 origin。

secrets、.state、.env 已被 Git 忽略。Cookie 文件不属于书籍元数据，不会被打入前端，也不会通过 Web API 提供。不要把真实登录态放进 book.json、队列文件或源码。

此前已用真实站点验证浏览器 Cookie 能在新会话中恢复书目访问；这不代表任意纯 HTTP 客户端都能通过站点风控。若站点要求浏览器验证，本脚本会报告失败，不绕过验证码或访问限制。

### 网络连接

命令行默认沿用已有 HTTP_PROXY / HTTPS_PROXY / NO_PROXY；没有这些环境变量时，Windows 会读取当前用户已启用的系统 HTTP 代理。不会修改系统代理配置，本地地址默认直连。可通过 --proxy direct 强制直连，或 --proxy http://127.0.0.1:7897 指定代理；有认证信息的代理地址不要放进书籍 JSON。自动检测仅覆盖 Windows 手动代理，不解析 PAC 自动配置脚本。

## 阅读与检索

- 按书名、作者、简介、标签搜索；按分类、完结状态、最近阅读筛选。
- 查看完整资料、原始 JSON、文件列表、全文下载与自动生成的章节目录。
- 逐章在线阅读，左右方向键翻章，搜索目录。
- 日间/夜间主题，字号调整；章节位置、滚动位置和阅读设置保存在浏览器 localStorage。
- 适配桌面及手机。书库完全本地运行，不加载远程字体、分析脚本或在线 API。

## 检查

    npm test
    npm run build

测试覆盖：JSON+正文自动发现、平铺结构、无效资料隔离、路径越界拦截、原子发布、编码解析、全本下载、HTML 验证页拒绝、Cookie 作用域，以及 Web 导入到章节阅读和全文下载的闭环。

## API

    GET  /api/health
    GET  /api/library
    GET  /api/books/:id
    GET  /api/books/:id/chapters/:index
    GET  /api/books/:id/files/:kind
    POST /api/publish
    GET  /api/worker/status
    POST /api/worker/start
    POST /api/worker/stop
    GET  /api/auth/session
    POST /api/auth/login
    POST /api/auth/logout

章节序号从 0 开始。书籍目录使用服务器实时扫描，不需要维护总索引。管理写入只接受同源页面的 JSON 请求；启用登录后，任务状态、启停和导入在后端验证会话。公开模式必须配置管理账号。

## 当前范围

已实现文件驱动书库、完整元数据、文库资料与全本入口解析、按编号断点扫描、扫描后自动加入全文下载、全文导入/下载、自动上架、目录生成、阅读、公开访问与管理员账号密码登录。没有实现访客注册、评论、推荐投票、网站公告迁移或 EPUB 内文阅读。Node 服务监听本机地址，公开部署通过反向代理；支持根路径或子路径部署。EPUB/PDF 可以作为附件保留和下载。
