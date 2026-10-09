"""BMU Hub forecasting service (optional).

Run it and set FORECAST_URL=http://localhost:8000 in apps/api/.env. The API falls back to its own
TypeScript forecasts whenever this service is not set or not running.

  pip install -r requirements.txt   # FastAPI + uvicorn
  python main.py                    # serves on port 8000 (PORT to change)

Without FastAPI installed, `python main.py` still serves the same endpoints with the standard library.
"""
from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import models

PORT = int(os.environ.get("PORT", "8000"))

try:
    from fastapi import FastAPI

    app = FastAPI(title="BMU Hub forecasting")

    @app.get("/health")
    def health() -> dict:
        return {"ok": True}

    @app.post("/revenue")
    def revenue(body: dict) -> dict:
        return models.revenue(body)

    @app.post("/churn")
    def churn(body: dict) -> dict:
        return models.churn(body)

except ImportError:  # pragma: no cover - fallback without FastAPI
    app = None


class Handler(BaseHTTPRequestHandler):
    routes = {"/revenue": models.revenue, "/churn": models.churn}

    def _send(self, code: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        self._send(200, {"ok": True}) if self.path == "/health" else self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        fn = self.routes.get(self.path)
        if not fn:
            return self._send(404, {"error": "not found"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
            self._send(200, fn(body))
        except Exception as e:  # noqa: BLE001
            self._send(400, {"error": str(e)})

    def log_message(self, *args) -> None:  # quiet
        pass


if __name__ == "__main__":
    if app is not None:
        import uvicorn

        uvicorn.run(app, host="0.0.0.0", port=PORT)
    else:
        print(f"FastAPI not installed; serving with the standard library on port {PORT}")
        ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
