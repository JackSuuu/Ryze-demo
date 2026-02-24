# wgjazz1 部署流程（BioVLM Only）

wgjazz1 只负责一件事：运行 BioVLM，通过 Cloudflare Tunnel 暴露给 VPS 上的 backend。

## 架构

```
VPS backend
    │ HTTPS + CF Access Token
    ▼
Cloudflare Access (验证 Token)
    │
    ▼ Tunnel B
wgjazz1
    └── biovlm-proxy :11436
            └── llama-server :11435
```

---

## Step 1：安装 cloudflared

```bash
curl -L --output /tmp/cloudflared.deb \
  https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i /tmp/cloudflared.deb
cloudflared --version
```

---

## Step 2：创建 Cloudflare Tunnel B（BioVLM）

```bash
cloudflared tunnel login
# 浏览器授权，保存 cert.pem

cloudflared tunnel create ryze-biolvlm
# 记下输出的 tunnel-id

cloudflared tunnel route dns ryze-biolvlm biolvlm.ryze.yourdomain.com
```

创建配置文件 `~/.cloudflared/config.yml`（参考 `deploy/cloudflared_biolvlm.yml.example`）：

```yaml
tunnel: <你的 tunnel-id>
credentials-file: /home/yanweiye/.cloudflared/<tunnel-id>.json

ingress:
  - hostname: biolvlm.ryze.yourdomain.com
    service: http://127.0.0.1:11436
  - service: http_status:404
```

手动测试连接：

```bash
# 先确保 biovlm-proxy 在跑（tmux 里的 claw:biovlm-proxy）
cloudflared tunnel run ryze-biolvlm
# 看到 "Registered tunnel connection" → OK，Ctrl+C
```

---

## Step 3：Cloudflare Dashboard — 配置 Access 保护 BioVLM

> 防止任何人直接调用 `biolvlm.ryze.yourdomain.com`

1. <https://one.dash.cloudflare.com> → **Zero Trust** → **Access** → **Applications**
2. **Add Application** → **Self-hosted**
   - Name: `BioVLM API`
   - Domain: `biolvlm.ryze.yourdomain.com`
3. 添加 Policy：**Block All**（Action: Block，Include: Everyone）
4. 保存

5. **Zero Trust** → **Access** → **Service Auth** → **Create Service Token**
   - 名称：`ryze-vps-backend`
   - ⚠️ **立即保存** Client ID 和 Client Secret（只显示一次！）
   - 这两个值填入 VPS 的 `backend/.env`：
     ```
     CF_BIOLVLM_CLIENT_ID=<id>
     CF_BIOLVLM_CLIENT_SECRET=<secret>
     ```

6. 回到 Application → **Add Policy**
   - Name: `Allow VPS Backend`，Action: **Allow**
   - Include: **Service Token** → `ryze-vps-backend`

---

## Step 4：systemd 服务

### 4.1 BioVLM Proxy

```bash
sudo tee /etc/systemd/system/biovlm-proxy.service << 'EOF'
[Unit]
Description=BioVLM Serverless Proxy
After=network.target

[Service]
Type=simple
User=yanweiye
WorkingDirectory=/data/jazz1/BioVLM_8B-V1
ExecStart=/home/yanweiye/.local/bin/uv run python biovlm_proxy.py
Restart=always
RestartSec=10
Environment=LD_LIBRARY_PATH=/home/yanweiye/Projects/claw/llama.cpp/build/bin:/home/yanweiye/Projects/claw/llama.cpp/build:/usr/local/cuda-13.0/lib64
Environment=PATH=/usr/local/cuda-13.0/bin:/usr/bin:/bin
TimeoutStartSec=180

[Install]
WantedBy=multi-user.target
EOF
```

### 4.2 Cloudflare Tunnel B

```bash
sudo cloudflared service install
# 自动读取 ~/.cloudflared/config.yml
```

如果 `service install` 不可用，手动创建：

```bash
sudo tee /etc/systemd/system/cloudflared-b.service << 'EOF'
[Unit]
Description=Cloudflare Tunnel B (BioVLM)
After=network.target

[Service]
Type=simple
User=yanweiye
ExecStart=/usr/bin/cloudflared tunnel run
Restart=on-failure
RestartSec=5s

[Install]
WantedBy=multi-user.target
EOF
```

### 4.3 启动

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now biovlm-proxy
sudo systemctl enable --now cloudflared-b   # 或 cloudflared.service

sudo systemctl status biovlm-proxy cloudflared-b
```

---

## Step 5：验证并停止 tmux 进程

```bash
# 验证 BioVLM proxy 本地正常
curl http://127.0.0.1:11436/health

# 验证通过 CF Tunnel 可访问（需要 Token）
curl -H "CF-Access-Client-Id: <id>" \
     -H "CF-Access-Client-Secret: <secret>" \
     https://biolvlm.ryze.yourdomain.com/health
```

确认 OK 后停止 tmux 里的旧进程：

```bash
# tmux claw session 中手动 Ctrl+C：
# - window 10: biovlm-server（llama-server，由 proxy 管理，不用单独留）
# - window 11: biovlm-proxy
# - window 12: ryze-backend（已迁移到 VPS，可关）
# - window 13: ryze-frontend（已迁移到 VPS，可关）
```

---

## 日志

```bash
sudo journalctl -u biovlm-proxy -f
sudo journalctl -u cloudflared-b -f
```

---

## 完成

wgjazz1 配置完成后，Service Token 填入 VPS `.env`，进行 VPS 部署。
