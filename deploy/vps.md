# VPS 部署流程（Backend + Frontend）

VPS 负责：ryze-backend（:8000）+ nginx（静态文件 + /api/ 反代）+ Cloudflare Tunnel A。
后端通过 CF Tunnel 调用 wgjazz1 上的 BioVLM，无需开放任何公网端口。

## 架构

```
用户浏览器
    │ HTTPS
    ▼
Cloudflare Tunnel A
    │
    ▼ → VPS nginx :80
         ├── / → 静态文件 /var/www/ryze/
         └── /api/* → ryze-backend :8000
                           │ HTTPS + CF Access Token
                           ▼
                       biolvlm.ryze.yourdomain.com
                           │ Tunnel B
                           ▼
                       wgjazz1 :11436
```

---

## 前置要求

- Ubuntu 22.04+ / Debian 12（或类似）
- Python 3.11+
- `uv` 包管理器
- nginx
- cloudflared
- git

---

## Step 1：基础环境

```bash
# 更新系统
sudo apt update && sudo apt upgrade -y

# 安装依赖
sudo apt install -y nginx git curl python3-pip

# 安装 uv
curl -LsSf https://astral.sh/uv/install.sh | sh
source ~/.bashrc

# 安装 cloudflared
curl -L --output /tmp/cloudflared.deb \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i /tmp/cloudflared.deb
cloudflared --version
```

---

## Step 2：拉取代码

```bash
git clone https://github.com/JackSuuu/Ryze-demo.git /opt/ryze
cd /opt/ryze
```

---

## Step 3：配置 Backend

```bash
cd /opt/ryze/backend

# 复制并填写环境变量
cp .env.example .env
vim .env
```

`.env` 关键字段：

```env
# BioVLM（wgjazz1 via Tunnel B）
OLLAMA_BASE_URL=https://biolvlm.ryze.yourdomain.com
OLLAMA_MODEL=biovlm-q8_0.gguf

# CF Access Token（从 wgjazz1 部署步骤拿到）
CF_BIOLVLM_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxx.access
CF_BIOLVLM_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# OpenRouter
OPENAI_API_KEY=sk-or-v1-...
OPENAI_BASE_URL=https://openrouter.ai/api/v1/
OPENAI_MODEL=gpt-4o-mini
```

安装 Python 依赖：

```bash
cd /opt/ryze/backend
uv venv
uv pip install -r requirements.txt
```

测试启动：

```bash
uv run uvicorn app:app --host 127.0.0.1 --port 8000 --env-file .env
# 访问 http://127.0.0.1:8000/health 验证
# Ctrl+C 退出
```

---

## Step 4：部署前端静态文件

```bash
sudo mkdir -p /var/www/ryze
sudo cp -r /opt/ryze/frontend/. /var/www/ryze/
sudo chown -R www-data:www-data /var/www/ryze
```

---

## Step 5：配置 nginx

```bash
sudo cp /opt/ryze/deploy/nginx.vps.conf /etc/nginx/sites-available/ryze
# 编辑 server_name 和 root（默认已正确）
sudo vim /etc/nginx/sites-available/ryze
# 修改: server_name ryze.yourdomain.com;

sudo ln -s /etc/nginx/sites-available/ryze /etc/nginx/sites-enabled/ryze
sudo rm -f /etc/nginx/sites-enabled/default   # 移除默认配置

sudo nginx -t      # 语法检查
sudo systemctl reload nginx
```

测试：

```bash
curl http://127.0.0.1/           # 返回 HTML
curl http://127.0.0.1/api/health # 返回后端响应
```

---

## Step 6：创建 Cloudflare Tunnel A（VPS）

```bash
cloudflared tunnel login
cloudflared tunnel create ryze-vps
# 记下 tunnel-id

cloudflared tunnel route dns ryze-vps ryze.yourdomain.com
```

创建 `~/.cloudflared/config.yml`（参考 `deploy/cloudflared_vps.yml.example`）：

```yaml
tunnel: <vps-tunnel-id>
credentials-file: /root/.cloudflared/<vps-tunnel-id>.json

ingress:
  - hostname: ryze.yourdomain.com
    service: http://127.0.0.1:80
  - service: http_status:404
```

手动测试：

```bash
cloudflared tunnel run ryze-vps
# 看到 "Registered tunnel connection" → OK，Ctrl+C
```

---

## Step 7：systemd 服务

### 7.1 Ryze Backend

```bash
sudo tee /etc/systemd/system/ryze-backend.service << 'EOF'
[Unit]
Description=Ryze Demo Backend
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/ryze/backend
ExecStart=/root/.local/bin/uv run uvicorn app:app \
    --host 127.0.0.1 \
    --port 8000 \
    --env-file .env
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
```

> 注意：`uv` 路径按实际安装位置调整（`which uv`）。

### 7.2 Cloudflare Tunnel A

```bash
sudo cloudflared service install
```

或手动：

```bash
sudo tee /etc/systemd/system/cloudflared-a.service << 'EOF'
[Unit]
Description=Cloudflare Tunnel A (VPS Frontend)
After=network.target

[Service]
Type=simple
ExecStart=/usr/bin/cloudflared tunnel run
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF
```

### 7.3 启动所有服务

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now ryze-backend
sudo systemctl enable --now cloudflared-a   # 或 cloudflared.service
sudo systemctl status ryze-backend cloudflared-a nginx
```

---

## Step 8：端到端验证

```bash
# 1. 前端页面
curl https://ryze.yourdomain.com
# 预期：返回 HTML

# 2. API 健康检查
curl https://ryze.yourdomain.com/api/health
# 预期：{"status": "ok"} 或类似

# 3. 直接访问 BioVLM 被拦截
curl https://biolvlm.ryze.yourdomain.com/health
# 预期：403（CF Access Block All）

# 4. 带 Token 访问 BioVLM
curl -H "CF-Access-Client-Id: <id>" \
     -H "CF-Access-Client-Secret: <secret>" \
     https://biolvlm.ryze.yourdomain.com/health
# 预期：{"status": "ok"}
```

---

## 日志

```bash
sudo journalctl -u ryze-backend -f
sudo journalctl -u cloudflared-a -f
sudo journalctl -u nginx -f
```

---

## 完成

整条链路：用户 → CF Tunnel A → VPS nginx → ryze-backend → CF Tunnel B (with Token) → wgjazz1 BioVLM
