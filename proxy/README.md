# Ryze Demo — Server A 部署指南

本目录为 **Server A（前端代理服务器）** 的部署代码。

## 架构

```
用户浏览器
    │ HTTPS
    ▼
Cloudflare 边缘
    ├── ryze.yourdomain.com   → Tunnel A → Server A :8443
    │       (static files + proxy)
    └── api.ryze.yourdomain.com → Tunnel B → Server B :8000
            (受 CF Access 保护，只允许 Server A 的 Service Token)
```

## 前置要求

- Python 3.11+
- `uv` 包管理器（推荐）或 pip
- `cloudflared` 已安装
- Cloudflare 账号 + 域名

## 部署步骤

### 1. 上传文件

将 `proxy/` 目录内容上传至 Server A 的 `/opt/ryze-proxy/`：

```bash
scp -r proxy/ user@server-a:/opt/ryze-proxy/
```

### 2. 复制前端静态文件

```bash
scp -r frontend/ user@server-a:/opt/ryze-proxy/public/
```

### 3. 配置环境变量

```bash
cd /opt/ryze-proxy
cp .env.example .env
vim .env   # 填写 BACKEND_URL 和 CF Access Token
```

### 4. 安装依赖

```bash
cd /opt/ryze-proxy
uv venv && uv pip install -r requirements.txt
# 或: python3 -m venv venv && venv/bin/pip install -r requirements.txt
```

### 5. 测试运行

```bash
cd /opt/ryze-proxy
.venv/bin/python main.py
# 访问 http://127.0.0.1:8443 验证
```

### 6. 配置 Cloudflare Tunnel A

```bash
cloudflared tunnel login
cloudflared tunnel create ryze-frontend
cloudflared tunnel route dns ryze-frontend ryze.yourdomain.com

# 复制并修改 cloudflared_a.yml.example
cp cloudflared_a.yml.example ~/.cloudflared/config.yml
# 填入实际 tunnel-id
```

### 7. systemd 服务

**代理服务** `/etc/systemd/system/ryze-proxy.service`：

```ini
[Unit]
Description=Ryze Demo Proxy
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/ryze-proxy
ExecStart=/opt/ryze-proxy/.venv/bin/python main.py
Restart=always
RestartSec=5
EnvironmentFile=/opt/ryze-proxy/.env

[Install]
WantedBy=multi-user.target
```

**Cloudflare Tunnel** `/etc/systemd/system/cloudflared-a.service`：

```ini
[Unit]
Description=Cloudflare Tunnel A (Frontend)
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/cloudflared tunnel run
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ryze-proxy cloudflared-a
```

## 验证

```bash
# 1. 前端页面正常返回
curl https://ryze.yourdomain.com

# 2. API 通过代理可访问
curl https://ryze.yourdomain.com/api/health

# 3. 直接访问后端被拦截（返回 403）
curl https://api.ryze.yourdomain.com/health
```

## 本地开发

不经过 Cloudflare，直接对 Server B 开发：
- 在前端 Settings 中将 API Endpoint 改为 `http://localhost:8000`
- 或在 wgjazz1 上用 `./run.sh all` 启动
