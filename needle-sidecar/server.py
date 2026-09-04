import json
import os
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer
from importlib.metadata import PackageNotFoundError, version

import needle


MAX_REQUEST_BYTES = 128 * 1024
try:
    NEEDLE_PACKAGE_VERSION = version("cactus-needle")
except PackageNotFoundError:
    NEEDLE_PACKAGE_VERSION = getattr(needle, "__version__", "unknown")

ROUTER_METADATA = {
    "engine": "needle2",
    "engine_version": "2.0.4",
    "model": "needle2-base",
    "package": "cactus-needle",
    "package_version": NEEDLE_PACKAGE_VERSION,
    "router_version": "0.1.0-test.12",
    "tool_schema_version": "3",
}
TOOLS = [
    {
        "name": "create_note",
        "description": "Save a note, idea, thought, observation, or fact for later. This is the default action when the user does not clearly request a different supported action. Not for a task the user wants to do later; use create_reminder for that.",
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "text": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 8000,
                    "description": "The user's complete input, copied word for word without summarizing or rewriting.",
                },
            },
            "required": ["text"],
        },
    },
    {
        "name": "create_reminder",
        "description": "Set a reminder, optionally for a future time. Use for reminder requests, 'remember to' tasks, or a future date or time paired with a task, even when the user does not say 'remind me'.",
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "message": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 200,
                    "description": "What to be reminded about, copied word for word without performing the task.",
                },
                "date_time_human": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 120,
                    "description": "The user's date or time phrase copied word for word. Omit this field when no time was spoken.",
                },
            },
            "required": ["message"],
        },
    },
    {
        "name": "forward_agent",
        "description": "Forward an explicitly delegated request to another AI agent.",
        "parameters": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "request": {
                    "type": "string",
                    "minLength": 1,
                    "maxLength": 500,
                    "description": "The delegated request copied word for word.",
                },
            },
            "required": ["request"],
        },
    },
]


def system_facts(context):
    supplied = context.get("date") if isinstance(context, dict) else None
    try:
        instant = datetime.fromisoformat(str(supplied).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        instant = datetime.now(timezone.utc)
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=timezone.utc)
    date_fact = instant.astimezone(timezone.utc).strftime("%Y-%m-%d %a %H:%M UTC")
    return (
        f"date: {date_fact}; locale: en; device: Pebble; assistant: Pebble Proxy. "
        "Route the voice capture to exactly one supported tool. Create a note with the user's complete input unless "
        "they clearly request a different supported action; ambiguous thoughts and observations default to create_note, "
        "without requiring action words such as 'create a note'. Use create_reminder for a task paired with a future "
        "date or time even without the word 'remind', and treat 'remember to do something' as a reminder while "
        "'remember that' followed by a fact remains a note. A reminder without a time is valid. Never invent a time "
        "or other detail. Copy user-provided values verbatim and always choose an action, falling back to create_note."
    )


class RouterHandler(BaseHTTPRequestHandler):
    server_version = "PebbleNeedle/1"

    def send_json(self, status, value):
        body = json.dumps(value, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path != "/healthz":
            self.send_json(404, {"error": "not_found"})
            return
        self.send_json(200, {
            "status": "ok",
            "ready": True,
            "engine": ROUTER_METADATA["engine"],
            "router": ROUTER_METADATA,
        })

    def do_POST(self):
        if self.path != "/v1/route":
            self.send_json(404, {"error": "not_found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"error": "invalid_content_length"})
            return
        if length < 1 or length > MAX_REQUEST_BYTES:
            self.send_json(413, {"error": "request_too_large"})
            return
        try:
            payload = json.loads(self.rfile.read(length))
            text = payload.get("text", "")
            if not isinstance(text, str) or not text.strip() or len(text.encode("utf-8")) > 64 * 1024:
                raise ValueError("invalid transcript")
            agent = needle.Needle(tools=TOOLS, system=system_facts(payload.get("context")))
            try:
                agent.reset()
                result = agent.complete(text.strip(), max_new_tokens=256)
            finally:
                agent.close()
            result = dict(result)
            result["router"] = ROUTER_METADATA
            self.send_json(200, result)
        except (json.JSONDecodeError, ValueError):
            self.send_json(400, {"error": "invalid_request"})
        except Exception:
            self.send_json(500, {"error": "inference_failed"})

    def log_message(self, _format, *_args):
        return


def main():
    # Load the engine before the service becomes reachable so health reflects
    # actual inference readiness. No transcript is used for this warm-up.
    warmup = needle.Needle(tools=TOOLS, system=system_facts({}))
    warmup.reset()
    warmup.close()
    host = os.environ.get("HOST", "0.0.0.0")
    port = int(os.environ.get("PORT", "8090"))
    HTTPServer((host, port), RouterHandler).serve_forever()


if __name__ == "__main__":
    main()
