"""ASGI middleware exposing /uncertainty/last endpoint for vLLM.

Returns the last log-variance value computed by
AigenR0ForConditionalGeneration.compute_logits().

Used by the backend's HeteroscedasticEstimator for refusal detection.
"""

import json

from starlette.types import ASGIApp, Receive, Scope, Send


class UncertaintyMiddleware:
    """Intercepts GET /uncertainty/last and returns the last uncertainty value."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http" and scope["path"] == "/uncertainty/last":
            from aigen_r0_plugin.model import get_last_uncertainty

            body = json.dumps(get_last_uncertainty()).encode("utf-8")
            await send({
                "type": "http.response.start",
                "status": 200,
                "headers": [
                    [b"content-type", b"application/json"],
                    [b"content-length", str(len(body)).encode()],
                ],
            })
            await send({
                "type": "http.response.body",
                "body": body,
            })
            return

        await self.app(scope, receive, send)
