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
ARCHIVE_BASE_PATH=/wenku/ npm run build
mkdir -p "$HOME/.config/wenku-archive" "$HOME/.config/systemd/user"
cp deploy/wenku-archive.service "$HOME/.config/systemd/user/"
```

建立 `~/.config/wenku-archive/server.env`，将下面的目录替换为自己用户的绝对路径，公开 origin 替换为真实地址。origin 只填写协议和主机（可含端口），不要包含 `/wenku/` 路径。

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

将 `deploy/nginx-location.conf` 复制到 Nginx snippets 目录，并在原有站点的 `server {}` 中 include。检查 `sudo nginx -t` 通过后 reload。书库位于 `/wenku/#/library`，任务管理位于 `/wenku/#/tasks`。本模板保留原站点其余路径。首次上线后，登录任务页可查看状态并点击启动；停止任务不关闭网站。

如果使用独立域名和根路径，构建时省略 `ARCHIVE_BASE_PATH`，参考 `deploy/nginx-root.conf`。HTTPS 由现有反向代理终止，`ARCHIVE_PUBLIC_ORIGIN` 必须与浏览器的 origin 完全一致。Node 服务始终绑定 `127.0.0.1`；不要直接暴露无反代的内部端口。

## 更新和回滚

保留数据目录，先确认 `git status` 没有需要保留的源码修改，然后：

```sh
git pull --ff-only
npm ci
npm test
ARCHIVE_BASE_PATH=/wenku/ npm run build
systemctl --user restart wenku-archive
```

服务停止时先请求下载器安全停止，扫描断点和已完成文件保存在数据目录。再次登录任务页启动后继续。发布前记录当前 Git commit，回滚时切回该 commit、重新构建并重启；无需删除运行数据。

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
