# 域名、IP 的 HTTPS 与自动续期

配置日期：2026-10-27（北京时间）。报价系统主访问地址为 `https://quote.omfreight.vip/`。域名和原公网 IP 入口分别使用 Let's Encrypt 证书；原 `https://47.82.68.65/` 继续可用。

## 域名解析

用户确认主域名为 `omfreight.vip`，选用 `quote` 子域名。阿里云 DNS 权威服务器为 `dns29.hichina.com` 与 `dns30.hichina.com`。记录为 A / 主机记录 quote / 记录值 47.82.68.65 / TTL 600 秒。权威 DNS、服务器解析和本机公网访问均已核对。没有更改主域名本身的记录。

## 持久配置

- Certbot 5.8.0 通过官方 Snap 安装，两张证书均使用 webroot 验证。IP 证书使用 `shortlived` 配置，有效期 160 小时；域名证书使用默认配置。
- IP 证书名称：`freight-quotes-ip`，目录 `/etc/letsencrypt/live/freight-quotes-ip/`。域名证书名称：`freight-quotes-domain`，目录 `/etc/letsencrypt/live/freight-quotes-domain/`。完整证书链和私钥仅保存在服务器，不复制到仓库或部署包。
- 域名证书 SAN 为 `quote.omfreight.vip`，签发者 Let's Encrypt YE2，当前证书到期时间为北京时间 2027-01-25 09:38:13，由定时任务自动续期。
- 验证目录：`/opt/freight-quotes/shared/acme-webroot`，通过 `ACME_WEBROOT_DIR` 指定。公网 TCP 80 的 `/.well-known/acme-challenge/` 路径持续提供验证文件。
- `deploy/v2/compose.override.yaml` 由 `compose.https.yaml` 激活，挂载 `nginx.https.conf` 和只读证书目录，并发布 TCP 443。普通 Compose 操作会自动加载该覆盖文件。
- 域名 HTTP 请求跳转到 `https://quote.omfreight.vip`，IP HTTP 请求继续跳转到 IP 的 HTTPS。均保留路径和查询参数；证书验证路径不跳转。
- 维护入口仍为主机 `127.0.0.1:8080`，映射容器内部 8080，沿用原来的 SSH 隧道。数据库和 API 的内部端口仍不公开。

## 自动续期

官方 `snap.certbot.renew.timer` 定时检查上述两张证书是否需要续期。成功续期后执行 `/etc/letsencrypt/renewal-hooks/deploy/freight-quotes-reload`，先检查 Nginx 配置，再重新加载证书，不重启数据库或 API。

```bash
sudo systemctl status snap.certbot.renew.timer
sudo systemctl list-timers 'snap.certbot*'
sudo /snap/bin/certbot certificates
sudo journalctl -u snap.certbot.renew.service --since '7 days ago'
sudo journalctl -t freight-quotes-https --since '7 days ago'
```

验证续期与重新加载链路：

```bash
sudo /snap/bin/certbot renew --cert-name freight-quotes-domain --dry-run --run-deploy-hooks --non-interactive --no-random-sleep-on-renew
# IP 证书单独验证时，将 cert-name 换为 freight-quotes-ip。
```

该检查使用测试签发服务，不替换当前正式证书。更新后的证书由原定时任务继续自动维护；没有另外创建 Codex 提醒或重复计划任务。

## 更新与恢复

更新应用时保留 `.env` 中的 `ACME_WEBROOT_DIR`、`LETSENCRYPT_DIR`、`HTTPS_PORT`，保留 `compose.override.yaml`，并随包更新 `nginx.conf`、`nginx.https.conf`。服务器证书和验证目录在发布目录之外，不随应用回退或换版丢失。

全新服务器先使用普通 HTTP 配置启动，并使验证目录可通过公网读取；随后安装 Certbot 5.4 或更新版本，为 IP 和 quote.omfreight.vip 分别申请上述证书名称的证书，再激活 HTTPS 覆盖文件。当前 nginx.https.conf 同时引用两张证书，不能在任意证书文件尚不存在时直接启动该配置。验证完成后才将 HTTP 切换为跳转，避免云防火墙尚未允许 443 时影响原网站。

TLS 配置支持 TLS 1.2 和 TLS 1.3。网站没有启用长期 HSTS，便于网络或证书异常时恢复维护入口。证书自动续期依赖 TCP 80 验证路径和服务器定时任务持续可用。

参考：[Let's Encrypt 的 Certbot IP 证书说明](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)。

域名配置前的 Nginx 备份位于服务器当前发布目录 `deploy/v2/nginx.https.before-domain-20261027.conf`。需要恢复仅 IP 入口时可恢复该文件，检查配置后重载；无需修改数据库或域名 DNS。
