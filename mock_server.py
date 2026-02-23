"""Mock backend with OpenAI-compatible endpoints."""

import json
import uuid
from http.server import HTTPServer, BaseHTTPRequestHandler

PORT = 3001


class MockHandler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

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

    def do_GET(self):
        if self.path == "/v1/models":
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

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        body = json.loads(self.rfile.read(length)) if length else {}

        if self.path == "/v1/chat/completions":
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
        print(f"[mock] {args[0]}")


if __name__ == "__main__":
    server = HTTPServer(("0.0.0.0", PORT), MockHandler)
    print(f"Mock server running on http://localhost:{PORT}")
    server.serve_forever()
