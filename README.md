# 🚀 Ryze AI Chatbot

<div align="center">
  <img src="https://img.shields.io/badge/Model-Qwen3--VL--8B--GRPO-blue" />
  <img src="https://img.shields.io/badge/Backend-ServerlessLLM-green" />
  <img src="https://img.shields.io/badge/Framework-FastAPI-red" />
  <img src="https://img.shields.io/badge/License-MIT-yellow" />
</div>

<br/>

一个炫酷的多模态 AI 聊天机器人，支持文字和图像理解，采用 **ServerlessLLM** 提供服务，基于 **Qwen3-VL-8B-GRPO** 模型。

![Ryze AI Demo](docs/demo.png)

## ✨ 特性

- 🎨 **精美 UI** - 现代化的暗色主题设计，流畅动画效果
- 🖼️ **多模态支持** - 支持图像上传和理解
- ⚡ **流式输出** - 实时显示 AI 回复
- 🔧 **可配置** - 灵活的模型参数设置
- 📱 **响应式设计** - 完美支持桌面和移动设备
- 🌙 **主题切换** - 支持深色/浅色主题

## 📁 项目结构

```
Ryze-demo/
├── backend/
│   ├── app.py              # FastAPI 后端服务
│   └── requirements.txt    # Python 依赖
├── frontend/
│   ├── index.html          # 主页面
│   ├── css/
│   │   └── style.css       # 样式文件
│   └── js/
│       └── app.js          # 前端逻辑
├── docker-compose.yml      # Docker 编排
└── README.md
```

## 🚀 快速开始

### 方式一：本地运行

#### 1. 启动后端

```bash
cd backend

# 安装依赖
pip install -r requirements.txt

# 启动服务
python app.py
```

后端将在 `http://localhost:8000` 启动。

#### 2. 启动前端

直接在浏览器中打开 `frontend/index.html`，或使用本地服务器：

```bash
cd frontend

# 使用 Python 简单服务器
python -m http.server 3000

# 或使用 Node.js serve
npx serve -l 3000
```

访问 `http://localhost:3000` 即可使用。

### 方式二：Docker 部署

```bash
docker-compose up -d
```

服务将在以下端口启动：
- 前端: `http://localhost:3000`
- 后端 API: `http://localhost:8000`

## 🔧 配置

### 后端配置

在 `backend/app.py` 中修改模型配置：

```python
MODEL_NAME = "chivier/qwen3-vl-8b-grpo"
```

### 前端配置

点击设置按钮 ⚙️ 可以调整：

- **API 端点** - 后端服务地址
- **Temperature** - 控制回复的随机性 (0-2)
- **最大 Token** - 限制回复长度
- **流式输出** - 启用/禁用流式响应

## 📡 API 接口

### 健康检查

```http
GET /health
```

### 非流式对话

```http
POST /chat
Content-Type: application/json

{
  "messages": [
    {"role": "user", "content": "你好"}
  ],
  "max_tokens": 2048,
  "temperature": 0.7
}
```

### 流式对话

```http
POST /chat/stream
Content-Type: application/json

{
  "messages": [
    {"role": "user", "content": "介绍一下自己"}
  ],
  "max_tokens": 2048,
  "temperature": 0.7,
  "stream": true
}
```

### 多模态对话（带图像）

```http
POST /chat/multimodal
Content-Type: multipart/form-data

message: 描述这张图片
image: [file]
max_tokens: 2048
temperature: 0.7
```

## 🏗️ 技术栈

### 后端
- **FastAPI** - 现代化 Python Web 框架
- **ServerlessLLM** - 高效的 LLM 服务框架
- **Qwen3-VL-8B** - 多模态视觉语言模型

### 前端
- **原生 HTML/CSS/JS** - 无框架依赖，轻量高效
- **Font Awesome** - 精美图标
- **Google Fonts (Inter)** - 现代字体

## 🎨 UI 预览

<table>
  <tr>
    <td><img src="docs/welcome.png" alt="Welcome Screen" /></td>
    <td><img src="docs/chat.png" alt="Chat Interface" /></td>
  </tr>
  <tr>
    <td align="center">欢迎界面</td>
    <td align="center">聊天界面</td>
  </tr>
</table>

## 🐛 故障排除

### 后端无法连接

1. 确保后端服务正在运行
2. 检查 CORS 设置
3. 确认 API 端点配置正确

### 模型加载失败

1. 检查 GPU 内存是否充足（建议 24GB+）
2. 尝试使用 `torch_dtype=torch.float16` 减少内存
3. 确保已安装所有依赖

## 📄 许可证

MIT License

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

---

<div align="center">
  <p>Made with ❤️ by Ryze Team</p>
  <p>Powered by <b>ServerlessLLM</b> + <b>Qwen3-VL-8B-GRPO</b></p>
</div>
