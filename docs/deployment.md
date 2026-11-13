# 公开部署与管理登录

书库列表、资料、章节、封面、全文下载公开访问。访客可通过 `#/register` 注册普通账号，表单仅有账号、密码和图片验证码；`#/login` 登录使用同样三个字段，不需要邮箱、手机号、第三方登录或数据库。扫描状态、启动、停止、书籍导入仅限管理员；注册用户无法取得管理权限。

密码使用随机盐和 scrypt 保存，注册用户写入管理凭据旁的私有 `users.json` 文件。浏览器使用 HttpOnly、SameSite=Strict 会话 Cookie；HTTPS 配置下添加 Secure。会话有效期 12 小时，退出立即失效，服务重启后需要重新登录。注册和每次登录均需五位图片验证码，五分钟有效、只能尝试一次、与当前浏览器绑定；点击图片可刷新。验证码在服务器核验，答案不随接口返回。不另设登录次数锁定或限流配置。公开模式未配置管理凭据时拒绝启动。

## 本地运行

需要 Node.js 22 或更新版本。

```sh
npm ci
npm run setup
npm run build
npm start
```

默认打开 `http://127.0.0.1:4178`，仅绑定本机。setup 保留已有书库、队列和断点，只补齐缺失文件。它加入一份可公开分享的原创短篇；默认任务队列为空且暂停，不会自动请求来源站。

启用登录：

```sh
npm run admin:create -- --username owner
ARCHIVE_AUTH_FILE=secrets/admin-auth.json npm start
```

第一个命令交互式输入密码，不回显。Windows PowerShell 使用 `$env:ARCHIVE_AUTH_FILE='secrets/admin-auth.json'; npm start`。也可以使用 `--generate` 生成随机密码，登录信息写入同目录私有文件 `admin-login.json`，不会打印到日志。需要自动化时使用 `--stdin`，通过标准输入提供 `{"username":"...","password":"..."}`；不要把真实密码写入命令参数。重置使用 `--force`，完成后重启服务。

## Linux + systemd + Nginx

推荐将源码与运行数据分开：

```text
~/apps/wenku-archive/                      Git 源码
~/.local/share/wenku-archive/library/      书库
~/.local/share/wenku-archive/.state/       扫描断点和日志
~/.local/share/wenku-archive/secrets/      私有凭据
~/.local/share/wenku-archive/download-queue.json
~/.config/wenku-archive/server.env         服务环境
```

在 `~/apps/wenku-archive` 中执行：

```sh
npm ci
npm run setup -- --data-dir "$HOME/.local/share/wenku-archive"
npm run admin:create -- --username owner --file "$HOME/.local/share/wenku-archive/secrets/admin-auth.json"
npm run build
mkdir -p "$HOME/.config/wenku-archive" "$HOME/.config/systemd/user"
cp deploy/wenku-archive.service "$HOME/.config/systemd/user/"
```

建立 `~/.config/wenku-archive/server.env`，将下面的目录替换为自己用户的绝对路径，公开 origin 替换为真实地址。origin 只填写协议和主机（可含端口），不包含路径。

```ini
ARCHIVE_PORT=4178
ARCHIVE_PUBLIC_ORIGIN=https://books.example.org
ARCHIVE_AUTH_FILE=/home/archive/.local/share/wenku-archive/secrets/admin-auth.json
ARCHIVE_LIBRARY=/home/archive/.local/share/wenku-archive/library
ARCHIVE_QUEUE=/home/archive/.local/share/wenku-archive/download-queue.json
ARCHIVE_STATE_DIR=/home/archive/.local/share/wenku-archive/.state
```

```sh
chmod 600 "$HOME/.config/wenku-archive/server.env"
systemctl --user daemon-reload
systemctl --user enable --now wenku-archive
sudo loginctl enable-linger "$(id -un)"
```

将 `deploy/nginx-location.conf` 复制到 Nginx snippets 目录，并在公开站点的 `server {}` 中 include。该配置将文库放在域名根路径 `/`，将旧 `/wenku/` 地址跳转到首页，并把原站点保留在 `/worldseed/`。确认同一个 `server {}` 中没有重复的 `location /`，运行 `sudo nginx -t` 通过后 reload。书库位于 `/#/library`，任务管理位于 `/#/tasks`。首次上线后，登录任务页可查看状态并点击启动；停止任务不关闭网站。

如果使用独立域名和根路径，构建时省略 `ARCHIVE_BASE_PATH`，参考 `deploy/nginx-root.conf`。HTTPS 由现有反向代理终止，`ARCHIVE_PUBLIC_ORIGIN` 必须与浏览器的 origin 完全一致。Node 服务始终绑定 `127.0.0.1`；不要直接暴露无反代的内部端口。

## 更新和回滚

保留数据目录，先确认 `git status` 没有需要保留的源码修改，然后：

```sh
git pull --ff-only
npm ci
npm test
npm run build
systemctl --user restart wenku-archive
```

服务停止时先请求下载器安全停止，扫描断点和已完成文件保存在数据目录。再次登录任务页启动后继续。发布前记录当前 Git commit，回滚时切回该 commit、重新构建并重启；无需删除运行数据。

组合站点的 Nginx 已直接提供静态前端时，只更新 `/srv/niko-archive/niko-wenku/dist/` 即可发布页面，**无需重启主后端或任务下载器**。只有主后端代码升级才需要上述 restart；只读备用有自己的发布目录和服务，不能一起停止或覆盖。

## CLI 公开 API 主备冗余

`nikowenku-archive` 继续使用原来的公开地址。Nginx 将搜索、资料、章节、封面和下载请求优先交给 `127.0.0.1:4178` 的主服务；连接失败、响应超时或返回 500/502/503/504 时，在响应发送给客户端前重试 `127.0.0.1:4179` 的只读备用。主服务恢复后，在短暂故障探测窗口结束后重新优先走主服务。404、401、403 不触发切换。现有 npm 客户端无须升级或改地址。

两套公开读取路径均保留：`/nikowenku-archive/api/library`、`/nikowenku-archive/api/books/...`，以及旧客户端的 `/api/library`、`/api/books/...`。登录、会话、扫描状态、任务启停和导入接口始终只连接主服务，主服务离线时这些管理功能也会离线；不会将写操作重试到备用。

备用服务 `niko-wenku-read-api.service` 的约束：

- 只开放读取接口的 GET/HEAD；所有写请求返回 405，任务和账号接口不开放。
- 不配置任务队列或管理凭据，不创建 worker，不运行来源站扫描、书籍下载、书库更新或导入任务。
- 通过现有目录读取书库，systemd 将书库挂为只读；只有独立的 `/var/lib/niko-wenku-read-api/` 检索缓存可写。此处生成目录索引不是更新书库，不会更改正文或元数据。
- 运行代码固定在 `/srv/niko-archive/services/wenku-read-api/releases/<版本>/`，`current` 指向当前版本；不使用主后端代码目录，也不会被网页发布覆盖。
- 只绑定本机 4179，进程异常退出由 systemd 自动重启；无第三方 npm 运行依赖。

### 安装与独立升级

备用入口、实现源码、systemd 模板、安装脚本和 Nginx 配置均跟踪在 `niko-wenku` Git 仓库中。组合仓库的 `npm run package:site` 会将这些文件带入发布包，`npm run deploy` 则在发布网页前自动运行 `deploy/ensure-read-api.mjs`：只检查本机备用的健康响应和书目读取，健康就跳过，不变更代码版本、PID 或 Nginx 配置；不可用才调用安装脚本重新部署并启用。修复后仍不可用则退出失败，保留当前网页，不继续发布。

只检查并按需修复备用（不主动升级健康服务）：

```sh
sudo node deploy/ensure-read-api.mjs \
  liuqi /home/liuqi/.local/share/wenku-archive/library \
  http://111.229.32.85 /etc/nginx/sites-enabled/worldseed
```

在 Linux 服务器上的 `niko-wenku` 源码目录执行（替换用户名、真实书库路径、公开 origin 和站点配置路径）：

```sh
node --test test/read-api.test.mjs test/read-failover-config.test.mjs
node deploy/test-read-failover.mjs
sudo bash deploy/install-read-api.sh \
  liuqi /home/liuqi/.local/share/wenku-archive/library \
  http://111.229.32.85 /etc/nginx/sites-enabled/worldseed
```

隔离集成检查需要本机安装 Nginx，只使用临时目录、高位本机端口和临时测试进程，**不会停止实际主服务或重载生产 Nginx**。它验证主优先、故障切换、超时、404 不切换、恢复回切、两套地址、正文哈希和管理接口隔离。

安装脚本只复制备用需要的六个原生 Node 模块，先预热独立索引并确认健康，再为现有站点插入带标记的 include，保留 HTTPS、首页聊天、其他应用和主服务管理路由。Nginx 配置先备份并执行 `nginx -t`，通过后才平滑 reload，校验或 reload 失败则恢复配置。备用启动失败时也会恢复前一备用版本。重新执行同一命令即可升级备用，不重启主服务；新安装和升级均不自动重启扫描/下载任务。

不使用 systemd 时也可单独运行，但书库的操作系统级只读权限需自己配置：

```sh
node server/read-api.mjs --library /existing/library \
  --state-dir /separate/read-api-state --public-origin https://books.example.org
```

入口有意不使用主服务的 `ARCHIVE_PORT`、`ARCHIVE_STATE_DIR`、`ARCHIVE_QUEUE` 或 `ARCHIVE_AUTH_FILE`。对应环境变量为 `ARCHIVE_READ_PORT`（默认 4179）、`ARCHIVE_LIBRARY`、`ARCHIVE_READ_STATE_DIR` 和 `ARCHIVE_PUBLIC_ORIGIN`。书库必须已存在，缓存目录必须显式指定且位于书库之外。

### 检查与回滚

```sh
systemctl status niko-wenku-read-api.service
curl -fsS http://127.0.0.1:4179/api/health
curl -fsS http://127.0.0.1:4179/api/library?pageSize=1
journalctl -u niko-wenku-read-api.service --since '10 minutes ago'
sudo nginx -t
```

备用健康响应包含 `readOnly: true`。公网健康接口正常从主服务返回；主服务出现故障而备用接管时会带上该字段。备用只扫描本地目录来维护索引，不会访问下载源站。

发布日志会打印当前和上一备用版本。需要回滚备用时，先将 `current` 链接指向已验证的上一版本，再执行 `sudo systemctl restart niko-wenku-read-api.service`。Nginx 的原配置和 include 同目录保存为 `*.before-read-failover-<时间戳>`；回滚网关时恢复同一批备份（首次安装时删除新建的三个 read-failover 配置文件和站点标记块），`sudo nginx -t` 通过后再 `sudo systemctl reload nginx`。不要停止或重启 `wenku-archive.service` 来测试故障切换。

这是**同机、独立进程、共享只读书库**的冗余，适用于主进程故障和主后端发布，不覆盖整台服务器、Nginx、网络或共享磁盘故障。Nginx 只能在响应尚未发送时选择备用；已经开始传输的下载中途断开，现有 CLI 会报错并清理临时文件，需要重新执行下载，不具备自动续传。备用不是正文备份，完整灾备需要另一台机器和独立的数据副本。

## 仓库与运行数据

源码采用 MIT 许可证，原创示例可随项目分享。Git 默认排除完整运行书库、实际队列、Cookie、账号配置、日志及临时文件；它们不是部署代码。第三方书籍的内容权利不因本软件许可证而改变。公开实例仅放置自己有权公开分享的内容。

发布源码前执行 `npm run check:public`。该检查扫描 Git 跟踪文件的路径、大小和常见凭据格式，不能代替人工确认新增文件的用途。请勿使用 `git add -f` 强行纳入私有数据。

## API 权限

| 接口 | 访客 | 管理员 |
| --- | --- | --- |
| GET /api/library、/api/books/... | 可访问 | 可访问 |
| GET /api/auth/session | 仅返回当前会话状态 | 仅返回当前会话状态 |
| GET /api/auth/captcha?purpose=register 或 login | 获取图片验证码 | 获取图片验证码 |
| POST /api/auth/register | 账号、密码、验证码注册普通用户 | 不改变管理员账号 |
| POST /api/auth/login | 账号、密码、验证码登录 | 可重新登录 |
| POST /api/auth/logout | 清除 Cookie | 撤销当前会话 |
| GET /api/worker/status | 401 | 可访问 |
| POST /api/worker/start、stop | 401 | 可操作 |
| POST /api/publish | 401 | 可导入 |

所有管理写入均验证 Origin 和自定义请求头，不接受任意命令或路径参数。管理 Cookie 不放入 localStorage，密码与来源站 Cookie 不打进前端包。

已登录普通用户访问管理接口返回 403；未登录返回 401。注册请求中的 `role` 等额外字段不会授予管理权限。管理员仍由 `admin:create` 在服务器私下配置，代码中没有固定密码。
