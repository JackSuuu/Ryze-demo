"""Dev server: serves frontend + mock API at /api/*."""

import json
import mimetypes
import os
import uuid
from http.server import HTTPServer, BaseHTTPRequestHandler
from pathlib import Path

PORT = 3001
FRONTEND_DIR = Path(__file__).parent / "frontend"


class DevHandler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def _extract_user_content(self, messages):
        """Extract text and detect image from last user message."""
        for msg in reversed(messages):
            if msg.get("role") == "user":
                content = msg.get("content", "")
                if isinstance(content, str):
                    return content, False
                if isinstance(content, list):
                    text_parts = []
                    has_image = False
                    for part in content:
                        if part.get("type") == "text":
                            text_parts.append(part.get("text", ""))
                        elif part.get("type") == "image_url":
                            has_image = True
                    return " ".join(text_parts), has_image
        return "", False

    def _serve_file(self, file_path):
        """Serve a static file from the frontend directory."""
        if not file_path.is_file():
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not Found")
            return
        content_type, _ = mimetypes.guess_type(str(file_path))
        content_type = content_type or "application/octet-stream"
        data = file_path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _strip_api_prefix(self):
        """Strip /api prefix from path, return stripped path or None."""
        if self.path.startswith("/api/"):
            return self.path[4:]  # /api/v1/... -> /v1/...
        return None

    def do_GET(self):
        api_path = self._strip_api_prefix()
        if api_path is not None:
            # Mock API routes
            if api_path == "/v1/models":
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                models = {
                    "object": "list",
                    "data": [
                        {"id": "local/biolvlm-8b-grpo", "object": "model", "owned_by": "local"},
                        {"id": "openai/gpt-4o-mini", "object": "model", "owned_by": "openai"},
                    ],
                }
                self.wfile.write(json.dumps(models).encode())
            else:
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"status": "ok"}).encode())
            return

        # Serve static frontend files
        url_path = self.path.split("?")[0]
        if url_path == "/":
            url_path = "/index.html"
        file_path = FRONTEND_DIR / url_path.lstrip("/")
        self._serve_file(file_path)

    def do_POST(self):
        api_path = self._strip_api_prefix()
        if api_path is None:
            self.send_response(404)
            self.end_headers()
            return

        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}

        if api_path == "/v1/chat/completions":
            model = body.get("model", "local/biolvlm")
            messages = body.get("messages", [])
            stream = body.get("stream", False)

            user_text, has_image = self._extract_user_content(messages)
            image_note = " [+ image]" if has_image else ""

            provider = "BioVLM" if model.startswith("local/") else "OpenAI"
            reply = f"[{provider} echo] {user_text}{image_note}"

            if stream:
                chunk_id = f"chatcmpl-mock-{uuid.uuid4().hex[:12]}"
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Cache-Control", "no-cache")
                self.end_headers()

                # Role chunk
                first_chunk = {
                    "id": chunk_id,
                    "object": "chat.completion.chunk",
                    "model": model,
                    "choices": [{"index": 0, "delta": {"role": "assistant"}, "finish_reason": None}],
                }
                self.wfile.write(f"data: {json.dumps(first_chunk)}\n\n".encode())
                self.wfile.flush()

                # Content chunks
                words = reply.split(" ")
                for word in words:
                    content_chunk = {
                        "id": chunk_id,
                        "object": "chat.completion.chunk",
                        "model": model,
                        "choices": [{"index": 0, "delta": {"content": word + " "}, "finish_reason": None}],
                    }
                    self.wfile.write(f"data: {json.dumps(content_chunk)}\n\n".encode())
                    self.wfile.flush()

                # Final chunk
                final_chunk = {
                    "id": chunk_id,
                    "object": "chat.completion.chunk",
                    "model": model,
                    "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                }
                self.wfile.write(f"data: {json.dumps(final_chunk)}\n\n".encode())
                self.wfile.write(b"data: [DONE]\n\n")
                self.wfile.flush()
            else:
                response = {
                    "id": f"chatcmpl-mock-{uuid.uuid4().hex[:12]}",
                    "object": "chat.completion",
                    "model": model,
                    "choices": [
                        {
                            "index": 0,
                            "message": {"role": "assistant", "content": reply},
                            "finish_reason": "stop",
                        }
                    ],
                    "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
                }
                self.send_response(200)
                self._cors()
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(response).encode())
        else:
            self.send_response(404)
            self._cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"error": "not found"}).encode())

    def log_message(self, fmt, *args):
        print(f"[dev] {args[0]}")


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), DevHandler)
    print(f"Dev server running on http://localhost:{PORT}")
    print(f"  Frontend: {FRONTEND_DIR}")
    print(f"  API mock: http://localhost:{PORT}/api/v1/chat/completions")
    server.serve_forever()
